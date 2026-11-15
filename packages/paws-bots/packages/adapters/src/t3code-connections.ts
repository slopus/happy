import type { AdapterContext, ConnectorTool } from "@rakazo/adapter-kit";
import { CloudAgentRequestRejected } from "@rakazo/adapter-kit";
import type { McpServer, PrismaClient } from "@rakazo/db";
import { availableInSpace } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type {
  CloudAgentActor,
  CloudAgentConnection,
  UserCloudAgents,
} from "./cloud-agent-factory.js";
import { USER_CLOUD_AGENT_KEY_PREFIX } from "./cloud-agent-factory.js";
import { credentialDigest } from "./credential-digest.js";
import type { McpOAuthBroker } from "./mcp-oauth.js";
import { TOKEN_REFRESH_SKEW_MS } from "./mcp-oauth.js";
import { mcpToolAllowed } from "./mcp-tool-permissions.js";
import { listRemoteMcpTools } from "./remote-mcp.js";
import type { T3CodeCloudAgentOptions } from "./t3code-cloud-agent.js";
import { T3CodeCloudAgentProvider } from "./t3code-cloud-agent.js";

/**
 * T3 Code environments that users connected as remote MCP servers, as cloud-agent connections.
 * New launches require its OAuth and orchestrator protocol, independently of display labels.
 */
export class T3CodeConnections implements UserCloudAgents {
  private readonly fingerprints = new Map<string, { until: number; result: Promise<boolean> }>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly oauth: Pick<McpOAuthBroker, "providerFor">,
    private readonly transport: Pick<
      T3CodeCloudAgentOptions,
      "fetch" | "resolveHostname" | "allowPrivateEndpoint"
    > = {},
  ) {}

  /** The actor's first connected environment available in the Space and to these agents. */
  async forActor(
    actor: CloudAgentActor & { botIds?: string[] },
  ): Promise<CloudAgentConnection | null> {
    return (await this.connections(actor, true))[0] ?? null;
  }

  async listForActor(actor: CloudAgentActor): Promise<CloudAgentConnection[]> {
    return this.connections(actor, false);
  }

  private async connections(
    { botIds, ...actor }: CloudAgentActor & { botIds?: string[] },
    firstOnly: boolean,
  ) {
    const servers = await this.prisma.mcpServer.findMany({
      where: {
        ...usable(actor),
        secretId: { not: null },
        // The same per-agent access the server's own tools follow.
        ...(botIds && {
          AND: [
            {
              OR: [
                { allBots: true },
                { assignments: { some: { botId: { in: botIds }, spaceId: actor.spaceId } } },
              ],
            },
          ],
        }),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    // Each check reads a stored login, so the servers are read together, not one after another.
    const found = await Promise.all(
      servers.map(async (server) => {
        try {
          if (botIds && !(await this.authorized(server.id, actor, botIds))) return null;
          return await this.connect(server, actor, true);
        } catch (error) {
          // One unreadable server must not hide the others or the deployment's provider.
          getLogger().warn("cloud_agent.connection_unreadable", {
            "mcp.server.id": server.id,
            error,
          });
          return null;
        }
      }),
    );
    const connections = found.filter((connection) => connection !== null);
    return firstOnly ? connections.slice(0, 1) : connections;
  }

  async forKey(
    key: string,
    actor: CloudAgentActor & { botIds?: string[] },
  ): Promise<CloudAgentConnection | null> {
    if (!key.startsWith(USER_CLOUD_AGENT_KEY_PREFIX)) return null;
    const server = await this.prisma.mcpServer.findFirst({
      where: { id: key.slice(USER_CLOUD_AGENT_KEY_PREFIX.length), ...usable(actor) },
    });
    if (
      actor.botIds &&
      !(await this.authorized(key.slice(USER_CLOUD_AGENT_KEY_PREFIX.length), actor, actor.botIds))
    )
      return null;
    // A server its owner removed, disabled or disconnected refuses every call, so its agents
    // end as expired instead of polling forever.
    return (
      (server && (await this.connect(server, actor, false))) ?? {
        key,
        spaceId: actor.spaceId,
        provider: new T3CodeCloudAgentProvider({ endpoint: "", token: undefined }),
      }
    );
  }

  private async connect(server: McpServer, actor: CloudAgentActor, connectedOnly: boolean) {
    const oauth = await this.oauth.providerFor(server, actor);
    if (!oauth) return null;
    const discovery = oauth.discoveryState();
    const resource = discovery?.resourceMetadata;
    // Existing keys already selected this adapter: preserve recovery without discovery I/O.
    // Older stored metadata may omit the resource URL; new launches must have it.
    if (
      (connectedOnly || resource?.resource !== undefined) &&
      !sameUrl(resource?.resource, server.endpoint)
    )
      return null;
    const tokens = await oauth.tokens();
    const token = tokens?.access_token;
    // New agents need a grant that may start work, one that has not lapsed: T3 Code's approval
    // page starts at read only, and it issues no refresh token.
    if (
      connectedOnly &&
      (!token ||
        !tokens?.scope?.split(/\s+/).includes(OPERATE_SCOPE) ||
        Date.now() >=
          (oauth.accessTokenExpiresAt() ?? Number.POSITIVE_INFINITY) - TOKEN_REFRESH_SKEW_MS)
    )
      return null;
    if (connectedOnly) {
      const origin = new URL(server.endpoint!).origin;
      const issuers = [
        discovery?.authorizationServerUrl,
        discovery?.authorizationServerMetadata?.issuer,
        ...(resource?.authorization_servers ?? []),
      ].filter((value) => value !== undefined);
      if (issuers.some((value) => new URL(value).origin !== origin)) return null;
      if (
        resource?.scopes_supported &&
        !["orchestration:read", OPERATE_SCOPE].every((scope) =>
          resource.scopes_supported!.includes(scope),
        )
      )
        return null;
      if (!(await this.fingerprint(server, token!))) return null;
    }
    const provider = new T3CodeCloudAgentProvider({
      ...this.transport,
      endpoint: server.endpoint!,
      token,
      onTokenRejected: () => oauth.replaceRejectedToken(),
    });
    const authorize = async (context: AdapterContext) => {
      if (
        context.userId !== actor.userId ||
        context.spaceId !== actor.spaceId ||
        !context.botId ||
        !(await this.authorized(server.id, actor, [context.botId]))
      )
        throw new CloudAgentRequestRejected("expired");
    };
    return {
      key: `${USER_CLOUD_AGENT_KEY_PREFIX}${server.id}`,
      baseUrl: server.endpoint!,
      spaceId: actor.spaceId,
      provider: {
        describe: () => provider.describe(),
        launch: async (...args: Parameters<typeof provider.launch>) => {
          await authorize(args[1]);
          return provider.launch(...args);
        },
        reply: async (...args: Parameters<typeof provider.reply>) => {
          await authorize(args[2]);
          return provider.reply(...args);
        },
        // Revocation prevents new instructions while allowing status and cleanup.
        get: provider.get.bind(provider),
        cancel: provider.cancel.bind(provider),
      },
    };
  }

  private async authorized(serverId: string, actor: CloudAgentActor, botIds: string[]) {
    if (!botIds.length) return false;
    const server = await this.prisma.mcpServer.findFirst({
      where: { id: serverId, ...usable(actor) },
      include: {
        assignments: {
          where: { botId: { in: botIds }, userId: actor.userId, spaceId: actor.spaceId },
        },
      },
    });
    return Boolean(
      server &&
        botIds.every((botId) => {
          const assignment = server.assignments.find((item) => item.botId === botId);
          // An explicit assignment overrides allBots, just as the MCP connector does.
          if (!assignment) return server.allBots;
          return Object.keys(PROTOCOL).every((tool) => mcpToolAllowed(assignment, tool));
        }),
    );
  }

  private fingerprint(server: McpServer, token: string): Promise<boolean> {
    const key = credentialDigest(
      JSON.stringify([server.id, server.revision, server.endpoint, token]),
    );
    const cached = this.fingerprints.get(key);
    if (cached && cached.until > Date.now()) return cached.result;
    // Share in-flight probes too; bound both successful and failed discoveries.
    if (this.fingerprints.size >= 256)
      this.fingerprints.delete(this.fingerprints.keys().next().value!);
    const result = listRemoteMcpTools({
      ...this.transport,
      endpoint: server.endpoint!,
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    })
      .then(matchesProtocol)
      .catch(() => {
        // Never log remote error bodies, which may echo credentials.
        getLogger().warn("cloud_agent.fingerprint_unavailable", { "mcp.server.id": server.id });
        return false;
      });
    this.fingerprints.set(key, { until: Date.now() + 60_000, result });
    return result;
  }
}

const OPERATE_SCOPE = "orchestration:operate";

function sameUrl(a: string | undefined, b: string | null) {
  const normal = (url: string) => {
    try {
      return new URL(url).href.replace(/\/$/, "");
    } catch {
      return url;
    }
  };
  return a !== undefined && b !== null && normal(a) === normal(b);
}

function usable(actor: CloudAgentActor) {
  return { enabled: true, endpoint: { not: null }, ...availableInSpace(actor) };
}

// Representative calls cover both launch paths and the model-selection retry. This is
// a conservative protocol fingerprint, not a general JSON Schema validator: unfamiliar
// schema forms fail closed; explicitly unconstrained schemas accept any value.
const PROTOCOL: Record<string, Record<string, unknown>[]> = {
  t3_project_list: [{ cursor: 0, limit: 100 }],
  t3_thread_launch: [
    { title: "Task", message: "Prompt", clientRequestId: "request", scratch: true },
    {
      title: "Task",
      message: "Prompt",
      clientRequestId: "request",
      projectId: "project",
      workspaceStrategy: { type: "worktree", baseRef: "HEAD" },
    },
    {
      title: "Task",
      message: "Prompt",
      clientRequestId: "request",
      scratch: true,
      modelSelection: { instanceId: "provider", model: "model" },
    },
  ],
  t3_thread_read: [{ threadId: "thread", limit: 1, runLimit: 50 }],
  t3_thread_send: [{ threadId: "thread", message: "Prompt", mode: "queue" }],
  t3_thread_interrupt: [{ threadId: "thread", runId: "run" }],
  t3_queue: [{ action: "cancel", threadId: "thread", queuedRunId: "run" }],
  orchestrator_capabilities: [{}],
};

function matchesProtocol(tools: ConnectorTool[]): boolean {
  return Object.entries(PROTOCOL).every(([name, calls]) => {
    const schema = tools.find((tool) => tool.name === name)?.inputSchema;
    return calls.every((args) => acceptsInput(schema, args));
  });
}

function acceptsInput(
  schema: unknown,
  input: unknown,
  depth = 0,
  root = schema,
  work = { remaining: 1024 },
): boolean {
  // The depth limit alone does not bound branching references or alternatives.
  // Share one budget across every branch of this representative call.
  if (--work.remaining < 0 || depth > 12) return false;
  // Unconstrained schemas accept leaf values only: an object argument, including a whole
  // tool input, must be described as one, or any server could advertise `{}` for every tool.
  const leaf = input === null || typeof input !== "object";
  if (typeof schema === "boolean") return schema && leaf;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  const value = schema as Record<string, unknown>;
  if (
    Object.keys(value).every((key) =>
      [
        "description",
        "title",
        "default",
        "examples",
        "$comment",
        "deprecated",
        "readOnly",
        "writeOnly",
      ].includes(key),
    )
  )
    return leaf;
  if (typeof value.$ref === "string") {
    if (!value.$ref.startsWith("#/")) return false;
    let target = root;
    for (const part of value.$ref.slice(2).split("/")) {
      if (!target || typeof target !== "object") return false;
      const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
      if (!Object.hasOwn(target, key)) return false;
      target = (target as Record<string, unknown>)[key];
    }
    return acceptsInput(target, input, depth + 1, root, work);
  }
  if (value.not !== undefined || value.if !== undefined) return false;
  if (
    Array.isArray(value.allOf) &&
    !value.allOf.every((part) => acceptsInput(part, input, depth + 1, root, work))
  )
    return false;
  const alternatives = value.anyOf ?? value.oneOf;
  if (Array.isArray(alternatives))
    return alternatives.some((part) => acceptsInput(part, input, depth + 1, root, work));
  if (value.const !== undefined) return value.const === input;
  if (Array.isArray(value.enum)) return value.enum.includes(input);
  if (typeof input === "object" && input !== null) {
    if (value.type !== "object") return false;
    const args = input as Record<string, unknown>;
    const properties = value.properties as Record<string, unknown> | undefined;
    return (
      (value.required === undefined ||
        (Array.isArray(value.required) &&
          value.required.every((key) => typeof key === "string" && Object.hasOwn(args, key)))) &&
      Object.entries(args).every(([key, item]) =>
        acceptsInput(properties?.[key], item, depth + 1, root, work),
      )
    );
  }
  if (typeof input === "number")
    return (
      (value.type === "number" || value.type === "integer") &&
      (typeof value.minimum !== "number" || input >= value.minimum) &&
      (typeof value.maximum !== "number" || input <= value.maximum)
    );
  if (typeof input === "string")
    return (
      value.type === "string" &&
      (typeof value.minLength !== "number" || input.length >= value.minLength) &&
      (typeof value.maxLength !== "number" || input.length <= value.maxLength)
    );
  return typeof input === "boolean" && value.type === "boolean";
}
