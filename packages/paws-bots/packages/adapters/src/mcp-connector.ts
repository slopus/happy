import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  OAuthError,
  ServerError,
  TemporarilyUnavailableError,
  TooManyRequestsError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type {
  AdapterContext,
  ConnectorCall,
  ConnectorEvent,
  ConnectorProvider,
  ConnectorTool,
  SecretStore,
} from "@rakazo/adapter-kit";
import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import type { McpOAuthEnvField } from "@rakazo/contracts";
import {
  isLocalhostOrLoopbackIp,
  mcpOAuthEnvReferences,
  resolveMcpOAuthEnv,
  resolveMcpOAuthFileTemplate,
} from "@rakazo/contracts";
import type { McpServer, PrismaClient, ThreadEvents } from "@rakazo/db";
import { availableInSpace, itemSecretIn } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { sanitizedError } from "@rakazo/logging/monitoring";
import { catalogToolPrefix } from "./approval-effect.js";
import {
  combineSignals,
  redactConnectorPayload,
  sanitizeConnectorError,
} from "./connector-safety.js";
import { credentialDigest } from "./credential-digest.js";
import {
  CATALOG_EXECUTE,
  catalogEntries,
  DIRECT_TOOL_LIMIT,
  executeLazyCatalogControl,
  isLazyCatalogControlRoute,
  lazyCatalogTools,
  resolveCatalogCall,
} from "./lazy-tool-catalog.js";
import { mcpToolAppResourceUri, readMcpApp } from "./mcp-app.js";
import { closeMcpResource } from "./mcp-close.js";
import type { McpOAuthBroker, OAuthMaterial } from "./mcp-oauth.js";
import {
  accessTokenExpiresAt,
  launchArgSecrets,
  looksLikeSecretValue,
  McpReauthorizationRequiredError,
  oauthMaterialSecrets,
  TOKEN_REFRESH_SKEW_MS,
} from "./mcp-oauth.js";
import type { InstalledMcpBin } from "./mcp-package-installer.js";
import {
  DEFAULT_MCP_INSTALL_TIMEOUT_MS,
  defaultMcpPackagesRoot,
  ensureMcpPackage,
  isNpxCommand,
  parseNpxLaunch,
} from "./mcp-package-installer.js";
import type { McpServerHealthUpdate } from "./mcp-server-health.js";
import { needsMcpOAuthClient, recordMcpServerHealth } from "./mcp-server-health.js";
import { mcpToolAllowed } from "./mcp-tool-permissions.js";
import { McpSession, mcpStdioRefusal } from "./mcp-transport.js";
import type { RemoteTransportDependencies } from "./remote-mcp.js";
import { ConnectorRedirectError, isMcpSessionGoneError, mcpToolFields } from "./remote-mcp.js";
import { appendToolCompletionAudit } from "./tool-completion-audit.js";

type SessionEntry = {
  session: McpSession;
  revision: number;
  material: OAuthMaterial;
  digest?: string;
  ref?: string;
  recordId?: string;
  /** For a process holding a renewable access token: when to replace it. */
  accessTokenExpiresAt?: number;
  /** Private directory holding the process's credential files; removed with the session. */
  credentialDir?: string;
  /** A local process, reaped after {@link McpConnectorOptions.idleMs} without use. */
  stdio: boolean;
  lastUsedAt: number;
  /** Resolved credential values the child may echo in errors or tool output. */
  launchSecrets?: string[];
};
class McpSecretChangedError extends Error {
  constructor() {
    super("Secret changed during MCP connection; retry");
  }
}

type PendingSession = {
  revision: number;
  promise: Promise<McpSession>;
  invalidated?: boolean;
  ref?: string;
};

export const DEFAULT_MCP_STDIO_STARTUP_TIMEOUT_MS = 30_000;
export const DEFAULT_MCP_STDIO_IDLE_MS = 15 * 60_000;
/** How long a run waits for one server's tool list before going on without it. */
export const DEFAULT_MCP_DISCOVERY_TIMEOUT_MS = 20_000;
/** After a failed discovery, runs skip the server for this long, doubling up to the max. */
const DISCOVERY_BACKOFF_MS = 30_000;
const DISCOVERY_BACKOFF_MAX_MS = 5 * 60_000;
/** A server that needs new credentials or a new address waits longer: retrying rarely
 * helps, but a failure that was only brief still gets another try. */
const RECONNECT_BACKOFF_MS = 60 * 60_000;

/** A server that did not list its tools within the discovery deadline. */
class McpDiscoveryTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`did not list its tools within ${Math.round(timeoutMs / 1000)}s`);
    this.name = "McpDiscoveryTimeoutError";
  }
}

/** Reject after `timeoutMs` without cancelling `promise`, which may finish in the background. */
function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new McpDiscoveryTimeoutError(timeoutMs)), timeoutMs);
  });
  // The losing side must not surface as an unhandled rejection.
  promise.catch(() => undefined);
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
/**
 * A failure the user resolves rather than a bug: `reconnect` needs new credentials or
 * config (each of which bumps the server's revision), including a host name that no
 * longer resolves, such as an expired tunnel; `unreachable` a host that is down. Both are
 * logged as warnings, so they stay out of error reporting.
 */
type ExpectedFailure = "reconnect" | "unreachable";
const UNREACHABLE_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function expectedFailure(error: unknown, depth = 0): ExpectedFailure | undefined {
  if (depth > 5 || !(error instanceof Error)) return undefined;
  if (error instanceof McpConnectFailure) return error.expected;
  if (error instanceof McpDiscoveryTimeoutError) return "unreachable";
  if (error instanceof McpReauthorizationRequiredError || error instanceof UnauthorizedError)
    return "reconnect";
  if (error instanceof StreamableHTTPError) {
    // A timeout, rate limit or server error is the server's own outage.
    if (error.code === 408 || error.code === 429 || (error.code ?? 0) >= 500) return "unreachable";
    // A 4xx or a non-MCP body (often an HTML page) means the endpoint is not an MCP server.
    if (error.code === -1 || (error.code !== undefined && error.code >= 400 && error.code < 500))
      return "reconnect";
  }
  // On a live session the next connect renews the token, so only wait briefly.
  if (isRejectedTokenError(error)) return "unreachable";
  // JSON-RPC reserves -32000 to -32099 for server errors, such as a proxy's failed upstream.
  if (error instanceof McpError && error.code <= -32000 && error.code >= -32099)
    return "unreachable";
  if (error instanceof ConnectorRedirectError) return "reconnect";
  // The server's own OAuth endpoint failed or is overloaded; it usually recovers by itself.
  if (
    error instanceof ServerError ||
    error instanceof TemporarilyUnavailableError ||
    error instanceof TooManyRequestsError
  )
    return "unreachable";
  // The authorization server refused our client or grant, or cannot register a client at
  // all; the user signs in again or enters a pre-registered client.
  if (error instanceof OAuthError || needsMcpOAuthClient(error)) return "reconnect";
  const code = (error as { code?: unknown }).code;
  if (code === "ENOTFOUND") return "reconnect";
  if (typeof code === "string" && UNREACHABLE_CODES.has(code)) return "unreachable";
  const inner = error instanceof AggregateError ? error.errors : [error.cause];
  for (const cause of inner) {
    const kind = expectedFailure(cause, depth + 1);
    if (kind) return kind;
  }
  return undefined;
}

/** JSON-RPC codes a server answers with HTTP 200, not 401, for an access token it no longer
 * accepts before its stated expiry, so the SDK never refreshes it (RingCentral: -32302). */
const REJECTED_TOKEN_CODES = new Set([-32302]);

function isRejectedTokenError(error: unknown): boolean {
  return error instanceof McpError && REJECTED_TOKEN_CODES.has(error.code);
}

/** Whether a failed call left its session usable: the connection is still up and the
 * failure came from the server's own JSON-RPC error or the run's cancellation, not from the
 * transport or a token the server stopped accepting. A server silent for the whole tool
 * timeout is treated as hung and restarted. */
function keepsMcpSession(
  session: McpSession | undefined,
  error: unknown,
  signal: AbortSignal,
): boolean {
  if (!session?.open) return false;
  if (signal.aborted) return true;
  return (
    error instanceof McpError &&
    error.code !== ErrorCode.RequestTimeout &&
    !isRejectedTokenError(error)
  );
}

/** A redacted connect failure that keeps whether it was expected, which its message loses. */
class McpConnectFailure extends Error {
  constructor(
    message: string,
    readonly expected: ExpectedFailure | undefined,
  ) {
    super(message);
    this.name = "McpConnectFailure";
  }
}

/** Whether a check after `since` (by this or another process) found the server working. */
function recoveredSince(
  server: { healthStatus?: string | null; healthCheckedAt?: Date | null },
  since: number,
): boolean {
  return server.healthStatus === "ok" && (server.healthCheckedAt?.getTime() ?? 0) > since;
}

/** Route name of the stand-in tool for an assigned server whose discovery failed. */
const UNAVAILABLE_TOOL = "__rakazo_unavailable";
/** Skip rewriting an unchanged health observation more often than this. */
const HEALTH_REWRITE_MS = 60_000;

export type McpConnectorOptions = {
  stdioEnabled?: boolean;
  allowedCommands?: string[];
  network?: RemoteTransportDependencies;
  /** Audit sink for failed discovery. Without it the log line stays the only trace. */
  events?: Pick<ThreadEvents, "append">;
  allowPrivateEndpoint?: boolean;
  /** Where `npx` packages are installed; see `defaultMcpPackagesRoot`. */
  packagesDir?: string;
  /** Upper bound for installing an `npx` package. */
  installTimeoutMs?: number;
  /** Upper bound for a stdio process to answer the MCP handshake, after any install. */
  startupTimeoutMs?: number;
  /** Stop a stdio process unused for this long; 0 keeps processes until the connector closes. */
  idleMs?: number;
  /** Parent for private per-process credential directories; defaults to the OS temp directory. */
  credentialTempRoot?: string;
  /** How long a run waits for one server's tool list; 0 waits for the transport's own timeouts. */
  discoveryTimeoutMs?: number;
};

function positiveInteger(value: string | undefined, allowZero = false): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && (allowZero ? parsed >= 0 : parsed > 0) ? parsed : undefined;
}

/** Stdio launch settings shared by the API and worker composition roots. */
export function mcpStdioOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Pick<
  McpConnectorOptions,
  "packagesDir" | "installTimeoutMs" | "startupTimeoutMs" | "idleMs" | "discoveryTimeoutMs"
> {
  return {
    packagesDir: defaultMcpPackagesRoot(env),
    installTimeoutMs:
      positiveInteger(env.MCP_STDIO_INSTALL_TIMEOUT_MS) ?? DEFAULT_MCP_INSTALL_TIMEOUT_MS,
    startupTimeoutMs:
      positiveInteger(env.MCP_STDIO_STARTUP_TIMEOUT_MS) ?? DEFAULT_MCP_STDIO_STARTUP_TIMEOUT_MS,
    idleMs: positiveInteger(env.MCP_STDIO_IDLE_MS, true) ?? DEFAULT_MCP_STDIO_IDLE_MS,
    discoveryTimeoutMs:
      positiveInteger(env.MCP_DISCOVERY_TIMEOUT_MS, true) ?? DEFAULT_MCP_DISCOVERY_TIMEOUT_MS,
  };
}

/** Stand-in for an assigned server whose tools could not be listed, so the model can say
 * why instead of concluding the server is not assigned. Calling it returns the reason. */
function unavailableTool(server: McpServer, reason: string): ConnectorTool {
  const brief = reason.length > 400 ? `${reason.slice(0, 400)}...` : reason;
  return {
    name: `mcp__${server.slug}__unavailable`,
    description: `The MCP server "${server.name}" is assigned to you but is unavailable right now, so none of its tools can be used. Reason: ${brief}. Tell the user it failed to start rather than saying it is not assigned. Calling this tool returns the same error.`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    route: {
      connectorId: "mcp",
      resourceId: server.id,
      resourceRevision: server.revision,
      toolName: UNAVAILABLE_TOOL,
      catalogGroup: server.slug,
    },
  };
}

/** Runtime MCP connector. Authorization is re-checked against the bot assignment on every call. */
/**
 * Stale allowlist entries are filtered out below with no error. Discovery already has the
 * live tool list, so compare once and warn when string allowlist names are missing from the
 * server. Non-string JSON values are ignored for both the missing list and the ratio.
 */
export function allowlistDrift(
  allowedTools: unknown,
  offered: Array<{ name: string }>,
): { missing: string[]; offered: number; stringAllowedCount: number } {
  const names = new Set(offered.map((tool) => tool.name));
  const allowed = Array.isArray(allowedTools) ? allowedTools : [];
  const stringAllowed = allowed.filter((name): name is string => typeof name === "string");
  return {
    missing: stringAllowed.filter((name) => !names.has(name)),
    offered: names.size,
    stringAllowedCount: stringAllowed.length,
  };
}

/** A server every agent may use acts as an assignment that allows all its tools. */
function sharedAssignment<Server extends { id: string }>(server: Server) {
  return { serverId: server.id, allowAllTools: true, allowedTools: [] as unknown, server };
}

function reportAllowlistDrift(
  assignment: { allowAllTools: boolean; allowedTools: unknown; server: { slug: string } },
  offered: Array<{ name: string }>,
  context: { spaceId: string; botId?: string },
): void {
  if (assignment.allowAllTools) return;
  const drift = allowlistDrift(assignment.allowedTools, offered);
  if (drift.missing.length === 0) return;
  getLogger().warn(
    `mcp allowlist drift on ${assignment.server.slug}: ${drift.missing.length}/${drift.stringAllowedCount} allowed tools are not offered (server offers ${drift.offered})`,
    {
      spaceId: context.spaceId,
      botId: context.botId,
      // Cap the list: the point is to name the drift, not to print an allowlist.
      missing: drift.missing.slice(0, 10),
    },
  );
}

/** Redact complete credential documents and values a process may quote separately. */
function credentialContentSecrets(content: string): string[] {
  const values = content.length >= 8 ? [content] : [];
  const visit = (value: unknown, key = ""): void => {
    if (typeof value === "string") {
      if (
        value.length >= 8 &&
        (/(secret|token|key|password|private|credential)/i.test(key) ||
          (value.length >= 16 && looksLikeSecretValue(value)))
      )
        values.push(value);
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) visit(child, key);
    }
  };
  try {
    visit(JSON.parse(content));
  } catch {
    for (const line of content.split(/\r?\n/).map((line) => line.trim())) {
      if (line.length >= 16 && looksLikeSecretValue(line)) values.push(line);
    }
  }
  return values;
}

/** Stop the process, then remove the credential files it was launched with. */
async function closeEntry(entry: { session: McpSession; credentialDir?: string }): Promise<void> {
  await closeMcpResource(() =>
    entry.session.close(async () => {
      if (entry.credentialDir)
        await rm(entry.credentialDir, { recursive: true, force: true }).catch(() => {
          // Filesystem errors can include credential paths; report only the failure.
          getLogger().warn("MCP credential file cleanup failed");
        });
    }),
  );
}

export class McpConnector implements ConnectorProvider {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly connecting = new Map<string, PendingSession>();
  private readonly probes = new Map<string, Promise<McpServerHealthUpdate>>();
  /** Last discovery failure per session key, returned by the unavailable stand-in tool. */
  private readonly unavailable = new Map<string, string>();
  private readonly healthWrites = new Map<string, { value: string; at: number }>();
  /** Servers whose last discovery failed; runs skip them until `until`, per revision. */
  private readonly discoveryBackoff = new Map<
    string,
    { revision: number; since: number; until: number; delayMs: number; reason: string }
  >();
  /** Session keys whose npx package is being installed right now. */
  private readonly installing = new Set<string>();
  private reaper?: ReturnType<typeof setInterval>;
  private resolvedPackagesRoot?: string;
  private readonly inFlight = new WeakMap<McpSession, number>();
  private readonly expired = new WeakSet<McpSession>();
  // Discovery runs more than once per run: once up front, then again on every lazy
  // catalog access. Each attempt needs its own executionId.
  private discoverySeq = 0;
  private readonly unsubscribe: () => void;
  constructor(
    private readonly prisma: PrismaClient,
    private readonly secrets: SecretStore,
    private readonly options: McpConnectorOptions = {},
    private readonly oauth?: McpOAuthBroker,
  ) {
    this.unsubscribe =
      this.secrets.onChange?.((ref) => {
        for (const [key, entry] of this.sessions)
          if (entry.ref === ref) void this.evict(key).catch(() => undefined);
        for (const entry of this.connecting.values())
          if (entry.ref === ref) entry.invalidated = true;
      }) ?? (() => {});
  }

  describe() {
    return {
      id: "mcp",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { discover: true, oauth: true, secretsBrokered: true },
    };
  }

  async discoverTools(context: AdapterContext): Promise<ConnectorTool[]> {
    const startedAt = Date.now();
    let tools: ConnectorTool[];
    try {
      tools = await this.authorizedTools(context);
    } catch (error) {
      // The registry logs and drops a connector that throws, so the run would lose every
      // assigned server's tools with nothing in the thread to say so.
      await this.recordDiscoveryFailure(undefined, error, context, startedAt, []);
      throw error;
    }
    if (tools.length <= DIRECT_TOOL_LIMIT) return tools;
    // Keep wrappers off "mcp_": see lazyCatalogTools.
    return lazyCatalogTools(catalogToolPrefix("mcp"), "mcp", "MCP", catalogEntries(tools));
  }

  async resolveCall(
    call: ConnectorCall,
    context: AdapterContext,
  ): Promise<{ call: ConnectorCall; tool: ConnectorTool } | undefined> {
    if (!call.route && call.tool.startsWith("mcp__")) {
      return resolveCatalogCall(
        { ...call, args: { id: call.tool, arguments: call.args } },
        catalogEntries(await this.authorizedTools(context)),
      );
    }
    // Wrappers have no resourceId; real tools always do.
    if (call.route?.resourceId || call.route?.toolName !== CATALOG_EXECUTE) return undefined;
    return resolveCatalogCall(call, catalogEntries(await this.authorizedTools(context)));
  }

  private async authorizedTools(context: AdapterContext): Promise<ConnectorTool[]> {
    if (!context.botId) return [];
    const usable = { enabled: true, ...availableInSpace(context) };
    const [assigned, shared] = await Promise.all([
      this.prisma.botMcpServer.findMany({
        where: {
          botId: context.botId,
          spaceId: context.spaceId,
          userId: context.userId,
          // A server no longer available in this space stays assigned but unused until it is again.
          server: usable,
        },
        include: { server: true },
      }),
      this.prisma.mcpServer.findMany({
        where: { ...usable, allBots: true, assignments: { none: { botId: context.botId } } },
      }),
    ]);
    const assignments = [...assigned, ...shared.map(sharedAssignment)];
    const groups = await Promise.all(
      assignments.map(async (assignment): Promise<ConnectorTool[]> => {
        const startedAt = Date.now();
        const server = assignment.server;
        const key = this.sessionKey(server, context);
        const live = this.sessions.get(key)?.revision === server.revision;
        // A package still installing finishes in the background; this run goes on without it.
        if (!live && this.installing.has(key))
          return [
            unavailableTool(
              server,
              "it is still installing its package; its tools will be available on a later turn",
            ),
          ];
        // A server that just failed is not retried on every turn; a live session, a new
        // revision (the user changed it), or a later successful check recorded by any
        // process (e.g. Test connection in the API) ends the wait early.
        const backoff = this.discoveryBackoff.get(key);
        if (
          !live &&
          backoff?.revision === server.revision &&
          Date.now() < backoff.until &&
          !recoveredSince(server, backoff.since)
        )
          return [unavailableTool(server, backoff.reason)];
        let entry: SessionEntry | undefined;
        // Past the deadline this run stops waiting for its own tools/list request only;
        // the session and other calls on it carry on.
        const listing = new AbortController();
        try {
          const listed = await withDeadline(
            this.withSession(server, context, (session) => {
              entry = this.sessions.get(key);
              return session.listTools({
                signal: AbortSignal.any([context.signal, listing.signal]),
              });
            }),
            this.options.discoveryTimeoutMs ?? DEFAULT_MCP_DISCOVERY_TIMEOUT_MS,
          );
          this.discoveryBackoff.delete(key);
          this.unavailable.delete(key);
          void this.recordHealth(
            assignment.server.id,
            { status: "ok", message: null, toolCount: listed.tools.length },
            { revision: server.revision },
          );
          reportAllowlistDrift(assignment, listed.tools, context);
          return listed.tools
            .filter((tool) => mcpToolAllowed(assignment, tool.name))
            .map((tool) => ({
              name: `mcp__${assignment.server.slug}__${tool.name}`,
              description: tool.description ?? tool.name,
              ...mcpToolFields(tool),
              route: {
                connectorId: "mcp",
                resourceId: assignment.serverId,
                resourceRevision: assignment.server.revision,
                toolName: tool.name,
                catalogGroup: assignment.server.slug,
                appResourceUri: mcpToolAppResourceUri(tool),
              },
            }));
        } catch (error) {
          if (error instanceof McpDiscoveryTimeoutError) listing.abort(error);
          // Capture material before eviction so the audited reason stays redacted, the
          // same reason execute() captures it before callTool.
          const material = (entry ?? this.sessions.get(key))?.material;
          const secrets = [
            ...(material ? oauthMaterialSecrets(material) : []),
            ...((entry ?? this.sessions.get(key))?.launchSecrets ?? []),
          ];
          const reason = this.installing.has(key)
            ? "it is still installing its package; its tools will be available on a later turn"
            : sanitizeConnectorError(error, secrets);
          // A single unavailable server must not hide tools from other connectors.
          // A cancelled run says nothing about the server.
          const expected = context.signal.aborted ? "unreachable" : expectedFailure(error);
          if (expected)
            getLogger().warn(`mcp discovery failed for server ${assignment.server.slug}`, {
              reason,
            });
          else
            getLogger().error(
              "mcp.discovery.failed",
              sanitizedError(error, (text) => sanitizeConnectorError(new Error(text), secrets)),
              {
                "connector.id": assignment.server.id,
              },
            );
          // Cleanup must not turn one server's failure into losing every server's tools.
          await this.evict(key).catch(() => undefined);
          this.unavailable.set(key, reason);
          // A cancelled run says nothing about the server, and an install that outlived the
          // deadline is still on its way.
          if (!context.signal.aborted && !this.installing.has(key)) {
            void this.recordHealth(
              assignment.server.id,
              { status: "error", message: reason },
              { revision: server.revision },
            );
            const delayMs = Math.min(
              (backoff?.revision === server.revision ? backoff.delayMs * 2 : 0) ||
                DISCOVERY_BACKOFF_MS,
              DISCOVERY_BACKOFF_MAX_MS,
            );
            this.discoveryBackoff.set(key, {
              revision: server.revision,
              since: Date.now(),
              // Reconnecting or editing the server bumps its revision, and Test connection
              // records a recovery, so either ends this wait early.
              until: Date.now() + (expected === "reconnect" ? RECONNECT_BACKOFF_MS : delayMs),
              delayMs,
              reason,
            });
          }
          await this.recordDiscoveryFailure(
            assignment.server.slug,
            error,
            context,
            startedAt,
            secrets,
          );
          return [unavailableTool(assignment.server, reason)];
        }
      }),
    );
    return groups.flat();
  }

  /**
   * Leave a failed discovery where every other tool outcome is already visible, as an
   * `agent.tool.completed` event with `outcome: "error"`. Losing a server's tools is
   * otherwise invisible: the run still ends `completed` and the model simply never sees
   * them. Discovery outside a run (settings, tool pickers) has no thread to attach to, so
   * there the log line stays the only trace.
   */
  private async recordDiscoveryFailure(
    slug: string | undefined,
    error: unknown,
    context: AdapterContext,
    startedAt: number,
    secrets: string[],
  ): Promise<void> {
    const events = this.options.events;
    if (!events || !context.runId || !context.botId) return;
    const run = await this.prisma.run
      .findUnique({ where: { id: context.runId }, select: { threadId: true } })
      .catch(() => null);
    if (!run) return;
    await appendToolCompletionAudit(
      { events },
      {
        spaceId: context.spaceId,
        threadId: run.threadId,
        botId: context.botId,
        runId: context.runId,
      },
      {
        name: slug ? `mcp__${slug}__discovery` : "mcp__discovery",
        executionId: `mcp-discovery-${slug ?? "all"}-${context.runId}-${this.discoverySeq++}`,
        durationMs: Date.now() - startedAt,
        error,
      },
      secrets,
    );
  }

  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    if (call.route?.connectorId !== "mcp") {
      yield { type: "error", message: `MCP route required for ${call.tool}` };
      return;
    }
    if (isLazyCatalogControlRoute(call.route)) {
      try {
        yield* executeLazyCatalogControl(
          call,
          catalogEntries(await this.authorizedTools(context)),
          (resolved) => this.execute(resolved, context),
        );
      } catch (error) {
        yield { type: "error", message: sanitizeConnectorError(error) };
      }
      return;
    }
    if (!call.route.resourceId) {
      yield { type: "error", message: `MCP route required for ${call.tool}` };
      return;
    }
    if (!context.botId) {
      yield { type: "error", message: "MCP tools require a bot context" };
      return;
    }
    const usable = { enabled: true, ...availableInSpace(context) };
    const assignment =
      (await this.prisma.botMcpServer.findFirst({
        where: {
          botId: context.botId,
          serverId: call.route.resourceId,
          spaceId: context.spaceId,
          userId: context.userId,
          server: usable,
        },
        include: { server: true },
      })) ??
      (await this.prisma.mcpServer
        .findFirst({ where: { ...usable, id: call.route.resourceId, allBots: true } })
        .then((server) => (server ? sharedAssignment(server) : null)));
    if (assignment && call.route.toolName === UNAVAILABLE_TOOL) {
      const reason =
        this.unavailable.get(this.sessionKey(assignment.server, context)) ??
        "it could not be started";
      yield {
        type: "error",
        message: `MCP server "${assignment.server.name}" is unavailable: ${reason}`,
      };
      return;
    }
    if (!assignment || !mcpToolAllowed(assignment, call.route.toolName)) {
      yield { type: "error", message: "MCP tool is not assigned to this bot" };
      return;
    }
    // Capture material before callTool so a concurrent eviction/replace cannot
    // drop this call's OAuth secrets from model-visible redaction. Recompute via
    // oauthMaterialSecrets(material) so in-place token refresh stays covered.
    let material: OAuthMaterial | undefined;
    let launchSecrets: string[] = [];
    const sessionKey = this.sessionKey(assignment.server, context);
    let used: McpSession | undefined;
    try {
      const toolName = call.route.toolName;
      const result = await this.withSession(assignment.server, context, (session) => {
        used = session;
        material = this.sessions.get(sessionKey)?.material;
        launchSecrets = this.sessions.get(sessionKey)?.launchSecrets ?? [];
        return session.callTool(toolName, call.args, { signal: context.signal });
      });
      const secrets = [...(material ? oauthMaterialSecrets(material) : []), ...launchSecrets];
      yield { type: "result", data: redactConnectorPayload(result, secrets) };
      const app = await readMcpApp(
        assignment.server.name,
        call.withApp ? call.route.appResourceUri : undefined,
        result,
        (uri) =>
          this.withSession(assignment.server, context, (session) =>
            session.readResource(uri, { signal: context.signal }),
          ),
        secrets,
      );
      if (app) yield { type: "app", app };
    } catch (error) {
      const secrets = [...(material ? oauthMaterialSecrets(material) : []), ...launchSecrets];
      // Drop a broken, hung or unauthorized connection, so the next call reconnects. A
      // cancelled run or the server's own error leaves a stdio process and the server's
      // session state in place. A session another call already replaced stays replaced:
      // evicting the key then would close the fresh one.
      const replaced = used !== undefined && this.sessions.get(sessionKey)?.session !== used;
      if (!replaced && !keepsMcpSession(used, error, context.signal)) await this.evict(sessionKey);
      yield { type: "error", message: sanitizeConnectorError(error, secrets) };
    }
  }

  /**
   * Launch (or reuse) a server once and list its tools, for the settings "Test connection"
   * and the check after a save. A live session in this process is reused; otherwise an
   * isolated session is started and stopped again. Concurrent probes of one server share a
   * result. The outcome is recorded as the server's health and returned.
   */
  probe(
    server: McpServer,
    context: { spaceId: string; userId: string; signal?: AbortSignal },
  ): Promise<McpServerHealthUpdate> {
    const timeoutMs =
      (this.options.installTimeoutMs ?? DEFAULT_MCP_INSTALL_TIMEOUT_MS) +
      (this.options.startupTimeoutMs ?? DEFAULT_MCP_STDIO_STARTUP_TIMEOUT_MS) +
      30_000;
    const adapterContext: AdapterContext = {
      operationId: `mcp-probe-${server.id}`,
      traceId: `mcp-probe-${server.id}`,
      spaceId: context.spaceId,
      userId: context.userId,
      signal: combineSignals(context.signal, AbortSignal.timeout(timeoutMs)),
    };
    const key = this.sessionKey(server, adapterContext);
    const probeKey = `${key} ${server.revision}`;
    const pending = this.probes.get(probeKey);
    if (pending) return pending;
    const promise = this.runProbe(server, adapterContext, key).finally(() => {
      if (this.probes.get(probeKey) === promise) this.probes.delete(probeKey);
    });
    this.probes.set(probeKey, promise);
    return promise;
  }

  private async runProbe(
    server: McpServer,
    context: AdapterContext,
    key: string,
  ): Promise<McpServerHealthUpdate> {
    let secrets: string[] = [];
    let update: McpServerHealthUpdate;
    // A process this one already runs (or is starting) answers; never launch a second.
    const shared =
      this.sessions.get(key)?.revision === server.revision ||
      this.connecting.get(key)?.revision === server.revision;
    try {
      let toolCount: number;
      if (shared) {
        toolCount = (
          await this.withSession(server, context, (session) => {
            const material = this.sessions.get(key)?.material;
            secrets = [
              ...(material ? oauthMaterialSecrets(material) : []),
              ...(this.sessions.get(key)?.launchSecrets ?? []),
            ];
            return session.listTools({ signal: context.signal });
          })
        ).tools.length;
      } else {
        const connected = await this.connectSession(server, context, () => undefined);
        secrets = [...oauthMaterialSecrets(connected.material), ...(connected.launchSecrets ?? [])];
        try {
          toolCount = (await connected.session.listTools({ signal: context.signal })).tools.length;
        } finally {
          await closeEntry(connected).catch(() => undefined);
        }
      }
      this.unavailable.delete(key);
      this.discoveryBackoff.delete(key);
      update = { status: "ok", message: null, toolCount };
    } catch (error) {
      // Like discovery: a shared session that cannot list its tools is dropped.
      if (shared) await this.evict(key).catch(() => undefined);
      update = { status: "error", message: sanitizeConnectorError(error, secrets) };
    }
    await this.recordHealth(server.id, update, { force: true, revision: server.revision });
    return update;
  }

  /**
   * Persist a health observation without ever failing the caller. Unchanged observations
   * are rewritten at most once a minute, so discovery on every turn is not a write each.
   * `revision` is the one observed: a sign-in or edit bumps it, and a slower observation of
   * the old revision must not replace the new one's health.
   */
  private async recordHealth(
    serverId: string,
    update: McpServerHealthUpdate,
    options: { force?: boolean; revision?: number } = {},
  ): Promise<void> {
    const value = JSON.stringify([
      update.status,
      update.message ?? null,
      update.toolCount ?? null,
      options.revision ?? null,
    ]);
    const last = this.healthWrites.get(serverId);
    const now = Date.now();
    if (!options.force && last?.value === value && now - last.at < HEALTH_REWRITE_MS) return;
    this.healthWrites.set(serverId, { value, at: now });
    try {
      await recordMcpServerHealth(this.prisma, serverId, update, options.revision);
    } catch {
      // Health is advisory; the recorder already logs.
    }
  }

  async close(): Promise<void> {
    this.unsubscribe();
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = undefined;
    await Promise.allSettled([...this.probes.values()]);
    await Promise.allSettled([...this.connecting.values()].map(({ promise }) => promise));
    await Promise.all([...this.sessions.values()].map((entry) => closeEntry(entry)));
    this.sessions.clear();
    this.connecting.clear();
  }

  private packagesRoot(): string {
    this.resolvedPackagesRoot ??= this.options.packagesDir ?? defaultMcpPackagesRoot();
    return this.resolvedPackagesRoot;
  }

  private sessionKey(server: McpServer, context: AdapterContext): string {
    // Identity headers are applied once, at connect time, so a session is only
    // valid for the identity it connected as. The key has to carry that identity.
    return `${server.id} ${context.spaceId} ${context.userId}`;
  }

  /** Stop stdio processes nobody used for `idleMs`. Returns how many were stopped. */
  async reapIdle(now = Date.now()): Promise<number> {
    const idleMs = this.options.idleMs ?? DEFAULT_MCP_STDIO_IDLE_MS;
    if (idleMs <= 0) return 0;
    const idle = [...this.sessions].filter(
      ([, entry]) =>
        entry.stdio &&
        (this.inFlight.get(entry.session) ?? 0) === 0 &&
        now - entry.lastUsedAt >= idleMs,
    );
    for (const [key, entry] of idle) {
      if (
        this.sessions.get(key) === entry &&
        (this.inFlight.get(entry.session) ?? 0) === 0 &&
        now - entry.lastUsedAt >= idleMs
      )
        await this.evict(key).catch(() => undefined);
    }
    return idle.length;
  }

  private startReaper(): void {
    const idleMs = this.options.idleMs ?? DEFAULT_MCP_STDIO_IDLE_MS;
    if (this.reaper || idleMs <= 0) return;
    this.reaper = setInterval(
      () => void this.reapIdle().catch(() => undefined),
      Math.max(1_000, Math.min(idleMs / 2, 60_000)),
    );
    this.reaper.unref?.();
  }

  /**
   * Stop reusing a session. A session other calls are still using is closed by the last of
   * them (see withSession), so one failure never cuts off another bot's running call.
   */
  private async evict(sessionKey: string): Promise<void> {
    const entry = this.sessions.get(sessionKey);
    if (!entry) return;
    this.sessions.delete(sessionKey);
    if ((this.inFlight.get(entry.session) ?? 0) > 0) {
      this.expired.add(entry.session);
      return;
    }
    await closeEntry(entry);
  }

  /**
   * Streamable HTTP servers answer 404 for a session they expired or lost on restart; many
   * (including the SDK's own "Server not initialized") answer 400 naming the session instead.
   * The request never ran there, so it is sent once more on a fresh session instead of failing.
   * While `use` runs, the session counts as active so the idle reaper leaves it alone.
   */
  private async withSession<T>(
    server: McpServer,
    context: AdapterContext,
    use: (session: McpSession) => Promise<T>,
  ): Promise<T> {
    const sessionKey = this.sessionKey(server, context);
    let retriedRotation = false;
    let retriedSessionLoss = false;
    for (;;) {
      let session: McpSession;
      try {
        session = await this.sessionFor(server, context);
      } catch (error) {
        // No tool has run yet: reconnect once with the current credentials.
        context.signal.throwIfAborted();
        if (retriedRotation || !(error instanceof McpSecretChangedError)) throw error;
        retriedRotation = true;
        continue;
      }
      this.inFlight.set(session, (this.inFlight.get(session) ?? 0) + 1);
      // A session in use is never reaped as idle.
      const entry = this.sessions.get(sessionKey);
      const tracked = entry?.session === session ? entry : undefined;
      try {
        return await use(session);
      } catch (error) {
        context.signal.throwIfAborted();
        if (retriedSessionLoss || !isMcpSessionGoneError(error)) throw error;
        retriedSessionLoss = true;
        // Stop reusing the expired session immediately, but let its other requests
        // receive their own responses before closing the shared SDK client.
        if (this.sessions.get(sessionKey)?.session === session) this.sessions.delete(sessionKey);
        this.expired.add(session);
      } finally {
        if (tracked) {
          tracked.lastUsedAt = Date.now();
        }
        const remaining = (this.inFlight.get(session) ?? 1) - 1;
        this.inFlight.set(session, remaining);
        if (remaining === 0 && this.expired.has(session))
          await closeEntry({ session, credentialDir: entry?.credentialDir });
      }
    }
  }

  private async sessionFor(server: McpServer, context: AdapterContext): Promise<McpSession> {
    const sessionKey = this.sessionKey(server, context);
    const existing = this.sessions.get(sessionKey);
    if (existing && existing.revision === server.revision) {
      existing.lastUsedAt = Date.now();
      // A stdio process reads its access token once at launch; relaunch it before the
      // token lapses so it starts with the renewed one.
      if (
        existing.accessTokenExpiresAt !== undefined &&
        Date.now() >= existing.accessTokenExpiresAt - TOKEN_REFRESH_SKEW_MS &&
        (this.inFlight.get(existing.session) ?? 0) === 0
      )
        await this.evict(sessionKey);
      // Every credential write stores a new record without bumping the revision, so a
      // different record means another process (an API or worker) changed the grant.
      else if ((server.secretId ?? undefined) !== existing.recordId) await this.evict(sessionKey);
      else if (existing.ref && server.secretId) {
        try {
          const plaintext = await this.secrets.load(existing.ref, {
            recordId: existing.recordId ?? server.secretId,
            signal: context.signal,
          });
          if (credentialDigest(plaintext) !== existing.digest) await this.evict(sessionKey);
        } catch (error) {
          context.signal.throwIfAborted();
          if (!(error instanceof SecretStoreUnavailableError)) {
            await this.evict(sessionKey);
            throw error;
          }
          // Keep live sessions usable during a store outage. Never log the error:
          // provider errors can contain credential values or private response data.
          getLogger().warn("MCP secret revalidation failed; retaining the live session");
        }
      }
      // A fresh read can detect rotation and synchronously evict this entry.
      if (this.sessions.get(sessionKey) === existing) return existing.session;
      return this.sessionFor(server, context);
    }
    const pending = this.connecting.get(sessionKey);
    if (pending?.revision === server.revision) return pending.promise;
    if (pending) {
      await pending.promise.catch(() => undefined);
      await this.evict(sessionKey);
      return this.sessionFor(server, context);
    }
    if (existing) await this.evict(sessionKey);

    let connected: SessionEntry | undefined;
    const promise = this.connectSession(server, context, (ref, recordId, digest) => {
      const entry = this.connecting.get(sessionKey);
      if (entry?.promise === promise) entry.ref = ref;
      const live = this.sessions.get(sessionKey);
      if (live && live === connected) {
        live.ref = ref;
        live.recordId = recordId;
        live.digest = digest;
      }
    }).then(
      async ({
        session,
        material,
        ref,
        digest,
        recordId,
        accessTokenExpiresAt,
        credentialDir,
        launchSecrets,
      }) => {
        if (this.connecting.get(sessionKey)?.invalidated) {
          await closeEntry({ session, credentialDir });
          throw new McpSecretChangedError();
        }
        connected = {
          session,
          revision: server.revision,
          material,
          ref,
          digest,
          recordId,
          accessTokenExpiresAt,
          credentialDir,
          stdio: server.transport === "stdio",
          lastUsedAt: Date.now(),
          launchSecrets,
        };
        this.sessions.set(sessionKey, connected);
        if (connected.stdio) this.startReaper();
        return session;
      },
      (error: unknown) => {
        // connectSession has already closed the failed connection and sanitized its error.
        // Share the rotation result with every caller waiting on this connection.
        if (this.connecting.get(sessionKey)?.invalidated) throw new McpSecretChangedError();
        throw error;
      },
    );
    this.connecting.set(sessionKey, { revision: server.revision, promise });
    try {
      return await promise;
    } finally {
      if (this.connecting.get(sessionKey)?.promise === promise) this.connecting.delete(sessionKey);
    }
  }

  private async connectSession(
    server: McpServer,
    context: AdapterContext,
    onRef: (ref: string, recordId: string, digest?: string) => void,
  ): Promise<{
    session: McpSession;
    material: OAuthMaterial;
    ref?: string;
    digest?: string;
    recordId?: string;
    accessTokenExpiresAt?: number;
    credentialDir?: string;
    launchSecrets?: string[];
  }> {
    let session = new McpSession({ name: `rakazo-${server.slug}` });
    let credentialDir: string | undefined;
    const launchSecrets: string[] = [];
    // Hoisted so a throw after the secret is decoded can still hand the material out.
    let material: OAuthMaterial | undefined;
    // What the process was handed; its stderr can echo any of it.
    try {
      let secret = server.secretId
        ? await this.prisma.secret.findFirst({
            where: { id: server.secretId, ...itemSecretIn(context) },
          })
        : null;
      if (server.secretId && !secret) {
        // OAuth refresh replaces the secret without updating this run's server snapshot.
        const current = await this.prisma.mcpServer.findFirst({
          where: { id: server.id, revision: server.revision, ...availableInSpace(context) },
          select: { secretId: true },
        });
        if (current?.secretId) {
          secret = await this.prisma.secret.findFirst({
            where: { id: current.secretId, ...itemSecretIn(context) },
          });
        }
        if (!secret) throw new Error("MCP server secret is unavailable; retry");
      }
      let ref = secret?.ciphertext;
      let recordId = secret?.id;
      if (secret) onRef(secret.ciphertext, secret.id);
      const plaintext = secret
        ? await this.secrets.load(secret.ciphertext, {
            recordId: secret.id,
            signal: context.signal,
          })
        : undefined;
      let digest = plaintext === undefined ? undefined : credentialDigest(plaintext);
      material = plaintext === undefined ? {} : (JSON.parse(plaintext) as OAuthMaterial);
      const loaded = { material, ...(secret ? { secretId: secret.id } : {}) };
      // Rows saved before arguments moved into the secret still hold them in plaintext.
      const args = material.args ?? (Array.isArray(server.args) ? server.args.map(String) : []);
      launchSecrets.push(...launchArgSecrets(args));
      const env = { ...(material.env ?? {}) };
      const onPersisted = (record: { id: string; ref: string; material: OAuthMaterial }) => {
        ref = record.ref;
        recordId = record.id;
        digest = credentialDigest(JSON.stringify(record.material));
        onRef(ref, recordId, digest);
      };
      let accessTokenExpiresAtMs: number | undefined;
      if (server.transport === "stdio") {
        const command = String(server.command ?? "");
        // The allowlist names the configured launcher (`npx`), checked before any install.
        // Only a deployment change or an edit to the server fixes a refusal, so wait for one.
        const refusal = mcpStdioRefusal(command, this.options);
        if (refusal) throw new McpConnectFailure(refusal, "reconnect");
        const npx = parseNpxLaunch(command, args);
        if (!npx && isNpxCommand(command))
          throw new McpConnectFailure("This npx command isn't supported here", "reconnect");
        let installedBin: InstalledMcpBin | undefined;
        if (npx) {
          // Install outside the startup timeout, once per package, into the shared volume.
          // npm sees the server's literal settings (e.g. NPM_CONFIG_*), never a grant.
          const installEnv = Object.fromEntries(
            Object.entries(env).filter(
              ([, value]) => mcpOAuthEnvReferences(value).fields.length === 0,
            ),
          );
          const installKey = this.sessionKey(server, context);
          let installHealth: { value: string; at: number } | undefined;
          try {
            installedBin = await ensureMcpPackage(npx.spec, {
              root: this.packagesRoot(),
              binName: npx.binName,
              timeoutMs: this.options.installTimeoutMs,
              signal: context.signal,
              env: installEnv,
              onSettled: async () => {
                if (installHealth && this.healthWrites.get(server.id) === installHealth)
                  await this.recordHealth(
                    server.id,
                    { status: "unknown", message: null },
                    { force: true, revision: server.revision },
                  );
              },
              onInstall: () => {
                this.installing.add(installKey);
                const installing = { status: "installing", message: null } as const;
                void this.recordHealth(server.id, installing, {
                  force: true,
                  revision: server.revision,
                });
                installHealth = this.healthWrites.get(server.id);
              },
            });
          } finally {
            this.installing.delete(installKey);
          }
        }
        let launchEnv = env;
        const files = material.files ?? {};
        const references = [...Object.values(env), ...Object.values(files)].map(
          (value) => mcpOAuthEnvReferences(value).fields,
        );
        let values: Partial<Record<McpOAuthEnvField, string>> = {};
        if (references.some((fields) => fields.length > 0)) {
          // The host holds the OAuth grant; the process only sees the values it asks for.
          const provider = await this.oauth?.providerFor(server, context, loaded, onPersisted);
          const tokens = await provider?.tokens();
          const expiresAt = accessTokenExpiresAt(material.oauth);
          if (!tokens || (expiresAt !== undefined && Date.now() >= expiresAt))
            throw new McpReauthorizationRequiredError(server.id);
          values = {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            client_id: material.oauthClient?.client_id,
            client_secret: material.oauthClient?.client_secret,
            expires_at: expiresAt === undefined ? undefined : String(expiresAt),
            scope: tokens.scope ?? material.oauthClient?.scope,
            token_type: tokens.token_type,
          };
          launchEnv = resolveMcpOAuthEnv(env, values);
          if (
            tokens.refresh_token &&
            references.some(
              (fields) => fields.includes("access_token") || fields.includes("expires_at"),
            )
          )
            accessTokenExpiresAtMs = expiresAt;
        }
        const resolvedFiles = Object.entries(files).map(
          ([key, template]) => [key, resolveMcpOAuthFileTemplate(template, values, key)] as const,
        );
        for (const [key, template] of Object.entries(env)) {
          const value = launchEnv[key];
          if (mcpOAuthEnvReferences(template).fields.length > 0 && value && value.length >= 8)
            launchSecrets.push(value);
        }
        for (const [key, content] of resolvedFiles) {
          if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error("Invalid MCP credential file name");
          launchSecrets.push(...credentialContentSecrets(content));
        }
        if (resolvedFiles.length > 0) {
          // One private directory per launched process. A file path replaces an env value of
          // the same name; the API rejects such overlaps, so this is only a safe fallback.
          credentialDir = await mkdtemp(
            join(this.options.credentialTempRoot ?? tmpdir(), "rakazo-mcp-"),
          );
          const dir = credentialDir;
          const previousOnClose = session.client.onclose;
          session.client.onclose = () => {
            try {
              previousOnClose?.();
            } finally {
              void rm(dir, { recursive: true, force: true }).catch(() => undefined);
            }
          };
          launchEnv = { ...launchEnv };
          for (const [key, content] of resolvedFiles) {
            const path = join(credentialDir, key);
            await writeFile(path, content, { mode: 0o600 });
            launchEnv[key] = path;
          }
        }
        await session.connectStdio({
          command,
          args: npx ? npx.binArgs : args,
          installedBin,
          env: launchEnv,
          allowedCommands: this.options.allowedCommands ?? [],
          signal: context.signal,
          timeoutMs: this.options.startupTimeoutMs ?? DEFAULT_MCP_STDIO_STARTUP_TIMEOUT_MS,
        });
      } else {
        const url = server.endpoint;
        if (!url) throw new Error("MCP endpoint is required");
        const endpoint = new URL(url);
        const localHttp =
          endpoint.protocol === "http:" && isLocalhostOrLoopbackIp(endpoint.hostname);
        const allowPrivateEndpoint = this.options.allowPrivateEndpoint === true;
        const authProvider =
          !localHttp && this.oauth
            ? await this.oauth.providerFor(server, context, loaded, onPersisted)
            : undefined;
        const staticToken = material.secret
          ? material.secret.startsWith("Bearer ")
            ? material.secret
            : `Bearer ${material.secret}`
          : undefined;
        const headers = {
          ...(material.headers ?? {}),
          ...(staticToken ? { Authorization: staticToken } : {}),
        };
        const connect = () =>
          session.connectRemote({
            url,
            urlPolicy: {
              allowHttpLocalhost: localHttp,
              allowLocalHttpCredentials: localHttp,
              allowPrivateEndpoint,
            },
            transport: server.transport === "sse" ? "sse" : "streamable-http",
            allowLegacySse: server.transport === "sse",
            headerPolicy: { headers },
            fallbackToSse: false,
            authProvider,
            network: this.options.network,
            signal: context.signal,
          });
        try {
          await connect();
        } catch (error) {
          if (!authProvider || !isRejectedTokenError(error)) throw error;
          await authProvider.replaceRejectedToken();
          await closeMcpResource(() => session.close());
          session = new McpSession({ name: `rakazo-${server.slug}` });
          await connect();
        }
      }
      return {
        session,
        material,
        ref,
        digest,
        recordId,
        accessTokenExpiresAt: accessTokenExpiresAtMs,
        credentialDir,
        launchSecrets,
      };
    } catch (error) {
      await closeEntry({ session, credentialDir }).catch(() => undefined);
      // Redact here, while the material is still in hand. This one rejection is handed
      // to every caller waiting on the same pending connect, and none of them can see
      // the secrets: the session never reached `sessions`. Sanitizing per caller would
      // cover only whoever looked first.
      if (!material) throw error;
      if (error instanceof McpReauthorizationRequiredError) throw error;
      throw new McpConnectFailure(
        sanitizeConnectorError(error, [...oauthMaterialSecrets(material), ...launchSecrets]),
        isRejectedTokenError(error) ? "reconnect" : expectedFailure(error),
      );
    }
  }
}
