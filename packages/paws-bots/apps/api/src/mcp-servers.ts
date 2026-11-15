import { ORPCError } from "@orpc/server";
import type { McpOAuthBroker, McpOAuthSummary, McpStdioPolicy } from "@rakazo/adapters";
import {
  assertNoMcpEndpointCredential,
  assertSafeRemoteUrl,
  buildMcpCredentialBlob,
  mcpServerHealthDto,
  mcpStdioRefusal,
  recordMcpServerHealth,
} from "@rakazo/adapters";
import type { Actor, McpServer, McpServerConfigInput } from "@rakazo/contracts";
import { mcpOAuthEnvReferences } from "@rakazo/contracts";
import type { McpServer as McpServerRow, Prisma } from "@rakazo/db";
import { itemSecretIn, spaceAvailability } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { isAdmin } from "./admins.js";
import { assertNameFreeWhereAvailable, userAddedAvailability } from "./availability.js";
import { dismissMcpServerApprovals } from "./mcp-approval.js";
import type { McpSecretMaterial } from "./mcp-material.js";
import { legacyMcpArgs } from "./mcp-material.js";
import type { RouterDeps } from "./router.js";
import { computerContext } from "./routes/shared.js";

export function mcpServerDto(
  row: {
    id: string;
    spaceId: string;
    slug: string;
    name: string;
    description: string;
    transport: string;
    endpoint: string | null;
    command: string | null;
    args: unknown;
    hasArgs: boolean;
    env: unknown;
    files: unknown;
    headers: unknown;
    secretId: string | null;
    installId?: string | null;
    allSpaces?: boolean;
    availableIn?: Array<{ spaceId: string }>;
    allBots?: boolean;
    enabled: boolean;
    verbatimResults?: boolean;
    revision: number;
    healthStatus: string;
    healthMessage: string | null;
    healthToolCount: number | null;
    healthCheckedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  },
  oauth: McpOAuthSummary = { status: "none", clientId: null, credential: true },
): McpServer {
  const keysOf = (value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : [];
  const envKeys = keysOf(row.env);
  const headerKeys = keysOf(row.headers);
  return {
    id: row.id,
    spaceId: row.spaceId,
    slug: row.slug,
    name: row.name,
    description: row.description,
    transport: row.transport as McpServer["transport"],
    endpoint: row.endpoint,
    command: row.command,
    hasArgs: row.hasArgs || legacyMcpArgs(row.args).length > 0,
    envKeys,
    fileKeys: keysOf(row.files),
    headerKeys,
    installId: row.installId ?? null,
    // A lone OAuth generation marker keeps a secret row without holding a credential.
    hasSecret: row.secretId !== null && oauth.credential,
    oauthStatus: oauth.status,
    oauthClientId: oauth.clientId,
    enabled: row.enabled,
    verbatimResults: row.verbatimResults ?? false,
    revision: row.revision,
    health: mcpServerHealthDto(row),
    availability: spaceAvailability({ ...row, allSpaces: row.allSpaces ?? false }),
    allBots: row.allBots ?? false,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const MCP_OAUTH_PENDING_MESSAGE = "Connect this server's account to check it.";

/** Private server endpoints require explicit operator configuration. */
export function mayUsePrivateEndpoint(deps: Pick<RouterDeps, "env">): boolean {
  return deps.env.mcpAllowPrivateEndpoint === true;
}

export function mcpStdioPolicy(deps: Pick<RouterDeps, "env">): McpStdioPolicy {
  return {
    stdioEnabled: deps.env.mcpStdioEnabled,
    allowedCommands: deps.env.mcpStdioAllowedCommands,
  };
}

/** A stdio server runs with the API's and worker's own access, so only admins add or change one. */
export async function assertMcpStdioAdmin(
  actor: Actor,
  deps: Pick<RouterDeps, "env" | "prisma">,
): Promise<void> {
  if (!(await isAdmin(deps, actor.userId)))
    throw new ORPCError("FORBIDDEN", { message: "Only admins can add local MCP servers" });
}

/** Refuse a stdio server this deployment would never run, or one a non-admin adds. */
export async function assertMcpStdioCommand(
  command: string,
  actor: Actor,
  deps: Pick<RouterDeps, "env" | "prisma">,
): Promise<void> {
  const refusal = mcpStdioRefusal(command, mcpStdioPolicy(deps));
  if (refusal) throw new ORPCError("BAD_REQUEST", { message: refusal });
  await assertMcpStdioAdmin(actor, deps);
}

export async function assertMcpRemoteEndpoint(
  endpoint: string | null | undefined,
  deps: Pick<RouterDeps, "remoteConnectors" | "env">,
): Promise<void> {
  if (!endpoint) return;
  try {
    await assertSafeRemoteUrl(endpoint, deps.remoteConnectors?.resolveHostname, {
      allowPrivateEndpoint: mayUsePrivateEndpoint(deps),
    });
    assertNoMcpEndpointCredential(endpoint);
  } catch (error) {
    throw new ORPCError("BAD_REQUEST", {
      message: error instanceof Error ? error.message : "MCP endpoint is invalid",
    });
  }
}

/** A stdio server gets its OAuth grant through `{{oauth.*}}` references in env
 * values and credential file templates, so they must name real fields and the
 * server must have a client to run the flow. A key is either a value or a file path. */
export function assertMcpOAuthTemplates(
  env: Record<string, string>,
  files: Record<string, string>,
  hasOAuthClient: boolean,
): void {
  for (const key of Object.keys(files)) {
    if (key in env) {
      throw new ORPCError("BAD_REQUEST", {
        message: `${key} is set as both an environment variable and a credential file`,
      });
    }
  }
  const sources = [
    ...Object.entries(env).map(([key, value]) => ({ label: `Environment variable ${key}`, value })),
    ...Object.entries(files).map(([key, value]) => ({ label: `Credential file ${key}`, value })),
  ];
  for (const { label, value } of sources) {
    const { fields, unknown } = mcpOAuthEnvReferences(value);
    if (unknown[0] !== undefined) {
      throw new ORPCError("BAD_REQUEST", {
        message: `${label} references unknown OAuth field {{oauth.${unknown[0]}}}`,
      });
    }
    if (fields[0] !== undefined && !hasOAuthClient) {
      throw new ORPCError("BAD_REQUEST", {
        message: `${label} uses {{oauth.${fields[0]}}}, which needs an OAuth client`,
      });
    }
  }
}

export function mcpAssignmentDto(row: {
  id: string;
  botId: string;
  serverId: string;
  allowAllTools: boolean;
  allowedTools: unknown;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    botId: row.botId,
    serverId: row.serverId,
    allowAllTools: row.allowAllTools,
    allowedTools: Array.isArray(row.allowedTools)
      ? row.allowedTools.filter((item): item is string => typeof item === "string")
      : [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function mcpCredentialRecords(
  material: unknown,
): { headers: Record<string, string>; env: Record<string, string> } | null {
  const record = (value: unknown): Record<string, string> | null => {
    if (value === undefined) return {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const entries = Object.entries(value);
    return entries.every(([, item]) => typeof item === "string")
      ? (Object.fromEntries(entries) as Record<string, string>)
      : null;
  };
  if (!material || typeof material !== "object" || Array.isArray(material)) return null;
  const { headers, env } = material as { headers?: unknown; env?: unknown };
  const parsed = { headers: record(headers), env: record(env) };
  return parsed.headers && parsed.env ? { headers: parsed.headers, env: parsed.env } : null;
}

export function createMcpServers(
  deps: RouterDeps,
  onboardingDeps: Parameters<typeof dismissMcpServerApprovals>[0],
  mcpOAuth: McpOAuthBroker,
) {
  const mcpAwaitsOAuth = async (server: McpServerRow, actor: Actor, oauth: McpOAuthSummary) => {
    if (oauth.status === "connected") return false;
    const secret = server.secretId
      ? await deps.prisma.secret.findFirst({
          where: { id: server.secretId, ...itemSecretIn(actor) },
        })
      : null;
    const material: McpSecretMaterial = secret
      ? JSON.parse(await deps.secrets.load(secret.ciphertext, { recordId: secret.id }))
      : {};
    const needsGrant = [
      ...Object.values(material.env ?? {}),
      ...Object.values(material.files ?? {}),
    ].some((value) => mcpOAuthEnvReferences(value).fields.length > 0);
    return (
      needsGrant ||
      (oauth.clientId !== null &&
        !material.secret &&
        Object.keys(material.headers ?? {}).length === 0)
    );
  };
  const probeMcpServer = async (server: McpServerRow, actor: Actor): Promise<void> => {
    if (!deps.mcp) return;
    try {
      // The connector records the outcome itself.
      await deps.mcp.probe(server, { spaceId: actor.spaceId, userId: actor.userId });
    } catch {
      getLogger().error("mcp server probe failed", { "mcp.server.id": server.id });
      await recordMcpServerHealth(
        deps.prisma,
        server.id,
        { status: "error", message: "Could not check this MCP server" },
        server.revision,
      );
    }
  };
  /**
   * Shows `installing` (stdio may have to download a package) and probes in the background.
   * Never throws; a probe problem must not fail the save.
   */
  const beginMcpProbe = async (
    row: McpServerRow,
    actor: Actor,
    oauth: McpOAuthSummary,
  ): Promise<McpServerRow> => {
    if (!deps.mcp || !row.enabled) return row;
    const shown = async (
      status: "unknown" | "installing",
      message: string | null,
    ): Promise<McpServerRow> => {
      await recordMcpServerHealth(deps.prisma, row.id, { status, message }, row.revision);
      return {
        ...row,
        healthStatus: status,
        healthMessage: message,
        healthToolCount: null,
        healthCheckedAt: new Date(),
      };
    };
    if (await mcpAwaitsOAuth(row, actor, oauth)) return shown("unknown", MCP_OAUTH_PENDING_MESSAGE);
    const display = row.transport === "stdio" ? await shown("installing", null) : row;
    void probeMcpServer(row, actor);
    return display;
  };
  const removeMcpServerInTransaction = async (
    tx: Prisma.TransactionClient,
    actor: Actor,
    server: { id: string; secretId: string | null },
  ) => {
    const painted = await dismissMcpServerApprovals(onboardingDeps, actor, server.id, tx);
    await tx.mcpServer.delete({ where: { id: server.id } });
    if (server.secretId) {
      await tx.secret.deleteMany({ where: { id: server.secretId, ...itemSecretIn(actor) } });
    }
    return painted;
  };
  const prepareMcpServer = async (actor: Actor, input: McpServerConfigInput) => {
    await assertMcpRemoteEndpoint("endpoint" in input ? input.endpoint : null, deps);
    if (input.transport === "stdio") {
      await assertMcpStdioCommand(input.command, actor, deps);
      assertMcpOAuthTemplates(input.env, input.files ?? {}, Boolean(input.oauthClient));
      await assertMcpRemoteEndpoint(input.oauthClient?.authorizationServer, deps);
    }
    const secretPayload = buildMcpCredentialBlob(input);
    return secretPayload
      ? await deps.secrets.put(secretPayload, computerContext(actor, "mcp", "mcp.create"))
      : null;
  };
  const insertMcpServer = async (
    tx: Prisma.TransactionClient,
    actor: Actor,
    input: McpServerConfigInput,
    stored: Awaited<ReturnType<typeof prepareMcpServer>>,
    // What the user adds reaches all their spaces and agents; an import stays with its agent.
    options: { everywhere?: boolean } = {},
  ) => {
    if (options.everywhere)
      await assertNameFreeWhereAvailable(
        tx,
        "mcpServer",
        actor,
        input.slug,
        userAddedAvailability(actor),
      );
    if (stored) {
      await tx.secret.create({
        data: {
          id: stored.id,
          userId: actor.userId,
          spaceId: options.everywhere ? null : actor.spaceId,
          kind: "mcp",
          ciphertext: stored.ciphertext,
        },
      });
    }
    return tx.mcpServer.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        allSpaces: options.everywhere ?? false,
        allBots: options.everywhere ?? false,
        slug: input.slug,
        name: input.name,
        description: input.description,
        transport: input.transport,
        endpoint: "endpoint" in input ? input.endpoint : null,
        command: "command" in input ? input.command : null,
        hasArgs: "args" in input && input.args.length > 0,
        env: ("env" in input
          ? Object.fromEntries(Object.keys(input.env).map((key) => [key, true]))
          : {}) as Prisma.InputJsonValue,
        files: Object.fromEntries(
          Object.keys("files" in input ? (input.files ?? {}) : {}).map((key) => [key, true]),
        ) as Prisma.InputJsonValue,
        headers: ("headers" in input
          ? Object.fromEntries(Object.keys(input.headers).map((key) => [key, true]))
          : {}) as Prisma.InputJsonValue,
        secretId: stored?.id,
        enabled: input.enabled,
        verbatimResults: input.verbatimResults,
      },
    });
  };
  const announceMcpServer = async (row: McpServerRow, actor: Actor) => {
    const oauth = await mcpOAuth.summaryFor(row, actor);
    return mcpServerDto(await beginMcpProbe(row, actor, oauth), oauth);
  };
  return {
    mcpAwaitsOAuth,
    probeMcpServer,
    beginMcpProbe,
    removeMcpServerInTransaction,
    prepareMcpServer,
    insertMcpServer,
    announceMcpServer,
  };
}
