import type {
  Composio,
  ConnectedAccountStatus,
  ToolRouterCreateSessionConfig,
} from "@composio/core";
import type {
  AdapterContext,
  ConnectedConnector,
  ConnectorCall,
  ConnectorCatalogItem,
  ConnectorEvent,
  ConnectorTool,
  ManagedConnectorProvider,
} from "@rakazo/adapter-kit";
import { ConnectorAuthUnavailableError } from "@rakazo/adapter-kit";
import { humanizeToolName } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { COMPOSIO_MULTI_EXECUTE_TOOL, composioToolBatch } from "./composio-batch.js";
import type { ToolkitDirectoryEntry } from "./composio-catalog-cache.js";
import {
  composioToolkitDirectory,
  createToolkitDirectoryCache,
  mergeCatalogWithConnected,
} from "./composio-catalog-cache.js";
import { collectPages, filterCatalog } from "./connector-catalog.js";
import { isVitestRuntime } from "./test-runtime.js";

type SdkSession = Awaited<ReturnType<Composio["create"]>>;

export type ComposioSession = Pick<
  SdkSession,
  "sessionId" | "toolkits" | "tools" | "execute" | "authorize"
>;

/** The Composio SDK surface the connector uses; offline tests inject a stateful fake. */
export type ComposioClient = {
  create(userId: string, config: ToolRouterCreateSessionConfig): Promise<ComposioSession>;
  sessions: { use(sessionId: string): Promise<ComposioSession> };
  connectedAccounts: Pick<Composio["connectedAccounts"], "list" | "waitForConnection" | "delete">;
  toolkits: {
    get(query: {
      limit?: number;
    }): Promise<Array<{ slug: string; noAuth?: boolean; composioManagedAuthSchemes?: string[] }>>;
  };
  getClient(): {
    tools: {
      list(
        query: { toolkit_slug: string; limit: number; cursor?: string },
        options?: { signal?: AbortSignal },
      ): Promise<{
        items: unknown[];
        next_cursor?: string | null;
      }>;
    };
  };
  authConfigs: {
    list(query: { limit?: number; cursor?: string }): Promise<{
      items: Array<{ toolkit: { slug: string }; status: string }>;
      nextCursor: string | null;
    }>;
  };
};

/** Account states the user can only leave by reconnecting. */
const RECONNECT_STATUSES: ConnectedAccountStatus[] = ["EXPIRED", "INACTIVE", "FAILED", "REVOKED"];

export function isComposioEnabled(apiKey: string | undefined): boolean {
  return Boolean(apiKey) && !isVitestRuntime();
}

export function asConnectorTools(input: unknown): ConnectorTool[] {
  const items = Array.isArray(input)
    ? input
    : input && typeof input === "object" && Array.isArray((input as { items?: unknown }).items)
      ? ((input as { items: unknown[] }).items ?? [])
      : [];
  const tools: ConnectorTool[] = [];
  for (const item of items) {
    const mapped = mapOneTool(item);
    if (mapped) tools.push(mapped);
  }
  return tools;
}

function mapOneTool(item: unknown): ConnectorTool | undefined {
  if (!item || typeof item !== "object") return undefined;
  const raw = item as Record<string, unknown>;
  if (raw.type === "function" && raw.function && typeof raw.function === "object") {
    const fn = raw.function as Record<string, unknown>;
    const name = String(fn.name ?? "");
    if (!name) return undefined;
    return {
      name,
      description: String(fn.description ?? name),
      inputSchema: asObject(fn.parameters) ?? { type: "object", properties: {} },
      batch: composioToolBatch(name),
      ...composioToolLabel(name),
      route: { connectorId: "composio", toolName: name },
    };
  }
  const name = String(raw.slug ?? raw.name ?? "");
  if (!name) return undefined;
  return {
    name,
    description: String(raw.description ?? name),
    inputSchema: asObject(raw.inputParameters) ??
      asObject(raw.inputSchema) ??
      asObject(raw.parameters) ?? { type: "object", properties: {} },
    batch: composioToolBatch(name),
    ...composioToolLabel(name),
    route: { connectorId: "composio", toolName: name },
  };
}

const COMPOSIO_TOOL_PREFIX = "COMPOSIO_";
const COMPOSIO_TOOL_LABELS: Record<string, string> = {
  COMPOSIO_SEARCH_TOOLS: "Searching your apps",
  COMPOSIO_GET_TOOL_SCHEMAS: "Checking app details",
  COMPOSIO_MULTI_EXECUTE_TOOL: "Using your apps",
  COMPOSIO_REMOTE_WORKBENCH: "Running code",
  COMPOSIO_REMOTE_BASH_TOOL: "Running code",
  COMPOSIO_MANAGE_CONNECTIONS: "Checking connections",
};

/** Session tools carry the vendor's name, which means nothing to the person watching. */
function composioToolLabel(name: string): { label?: string } {
  if (!name.startsWith(COMPOSIO_TOOL_PREFIX)) return {};
  return {
    label: COMPOSIO_TOOL_LABELS[name] ?? humanizeToolName(name.slice(COMPOSIO_TOOL_PREFIX.length)),
  };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export type ComposioCatalogItem = Omit<ConnectorCatalogItem, "connectorId">;

export interface ComposioProvider extends ManagedConnectorProvider {
  warmDirectory(): Promise<void>;
  listConnectedSlugs(userId: string): Promise<string[]>;
}

type ToolkitConnection = Awaited<ReturnType<ComposioSession["toolkits"]>>["items"][number];

function activeSlugs(toolkits: ToolkitConnection[]): string[] {
  return toolkits
    .filter((toolkit) => toolkit.connection?.isActive || toolkit.isNoAuth)
    .map((toolkit) => toolkit.slug);
}

function composioSlugKey(slug: string): string {
  return slug.trim().toLowerCase();
}

export function executeSessionKey(
  toolkits: string[],
  connectedAccounts: Record<string, string[]> = {},
): string {
  const unique = new Map<string, string>();
  for (const slug of toolkits) {
    const trimmed = slug.trim();
    const key = composioSlugKey(trimmed);
    if (key && !unique.has(key)) unique.set(key, trimmed);
  }
  const toolkitKey = [...unique.values()].sort().join(",");
  const accountKey = Object.entries(connectedAccounts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([toolkit, ids]) => `${toolkit}:${[...new Set(ids)].sort().join(",")}`)
    .join(";");
  return accountKey ? `${toolkitKey}|${accountKey}` : toolkitKey;
}

/** Connected-account listings are per user and toolkit; this bounds a runaway cursor. */
const MAX_ACCOUNT_PAGES = 20;
/** Folder listings treat a missing path as the account root. */
const DROPBOX_FOLDER_LIST_TOOLS = new Set(["DROPBOX_LIST_FILES_IN_FOLDER", "DROPBOX_LIST_FOLDERS"]);

export type ComposioExecutionCall = {
  tool: string;
  args: Record<string, unknown>;
  account?: string;
};

/**
 * `COMPOSIO_MULTI_EXECUTE_TOOL` nests each tool under `tools[]`. Dropbox folder
 * listing reads `arguments.path` and otherwise returns the account root, so a
 * path passed beside `arguments` or as a JSON string never selects the folder.
 * Those listing tools run directly with the folder path on the listing call.
 */
export function expandComposioMultiExecute(
  tool: string,
  args: Record<string, unknown>,
): ComposioExecutionCall[] {
  if (tool !== COMPOSIO_MULTI_EXECUTE_TOOL || !Array.isArray(args.tools)) {
    return [{ tool, args }];
  }
  const calls: ComposioExecutionCall[] = [];
  let pending: unknown[] = [];
  const flushPending = () => {
    if (pending.length === 0) return;
    calls.push({ tool, args: { ...args, tools: pending } });
    pending = [];
  };
  for (const item of args.tools) {
    const listing = dropboxFolderListCall(item);
    if (listing) {
      flushPending();
      calls.push(listing);
    } else {
      pending.push(item);
    }
  }
  flushPending();
  if (calls.length === 0 || (calls.length === 1 && calls[0]?.tool === tool)) {
    return [{ tool, args }];
  }
  return calls;
}

/** Composio tool slugs are prefixed with their toolkit slug, including multi-execute items. */
function callUsesToolkit(call: ConnectorCall, toolkit: string, toolkits: string[]): boolean {
  const prefix = `${composioSlugKey(toolkit)}_`;
  const tools = Array.isArray(call.args?.tools) ? call.args.tools : [];
  const slugs = [
    call.tool,
    ...tools.map((item) =>
      item && typeof item === "object" ? (item as { tool_slug?: unknown }).tool_slug : undefined,
    ),
  ];
  return slugs.some((slug) => {
    if (typeof slug !== "string") return false;
    const key = composioSlugKey(slug);
    if (!key.startsWith(prefix)) return false;
    // A longer connected toolkit owns its tools (e.g. GITHUB_MCP, not GITHUB).
    return !toolkits.some((candidate) => {
      const candidatePrefix = `${composioSlugKey(candidate)}_`;
      return candidatePrefix.length > prefix.length && key.startsWith(candidatePrefix);
    });
  });
}

function accountIsPinned(
  connectedAccounts: Record<string, string[]>,
  tool: string,
  account: string,
): boolean {
  const toolKey = composioSlugKey(tool);
  return Object.entries(connectedAccounts).some(
    ([toolkit, ids]) => toolKey.startsWith(`${composioSlugKey(toolkit)}_`) && ids.includes(account),
  );
}

function dropboxFolderListCall(item: unknown): ComposioExecutionCall | undefined {
  if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
  const record = item as Record<string, unknown>;
  const slug = typeof record.tool_slug === "string" ? record.tool_slug.trim() : "";
  if (!slug || !DROPBOX_FOLDER_LIST_TOOLS.has(slug.toUpperCase())) return undefined;
  const toolArgs = objectArguments(record.arguments);
  if (!toolArgs) {
    throw new Error("Dropbox folder listing arguments must be a JSON object.");
  }
  const path = nonEmptyPath(record.path);
  if (path && !nonEmptyPath(toolArgs.path)) toolArgs.path = path;
  const account = typeof record.account === "string" ? record.account.trim() : "";
  return account ? { tool: slug, args: toolArgs, account } : { tool: slug, args: toolArgs };
}

function objectArguments(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { ...(parsed as Record<string, unknown>) };
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) };
  }
  return {};
}

function nonEmptyPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export type PluginConnectionRow = {
  id: string;
  provider: string;
  status: string;
  displayName: string;
};

export function needsLivePluginSync(rows: { status: string }[]): boolean {
  return rows.some((row) => row.status === "pending" || row.status === "error");
}

export function mergeConnectedPlugins(
  rows: { provider: string; displayName: string; status?: string }[],
  liveSlugs: string[],
): { provider: string; displayName: string }[] {
  const live = new Set(liveSlugs.map((slug) => composioSlugKey(slug)).filter(Boolean));
  const byProvider = new Map<string, { provider: string; displayName: string }>();
  for (const row of rows) {
    if (!row.provider) continue;
    const include =
      row.status === "connected" ||
      row.status === undefined ||
      ((row.status === "pending" || row.status === "error") &&
        live.has(composioSlugKey(row.provider)));
    if (!include) continue;
    const current = byProvider.get(composioSlugKey(row.provider));
    if (!current || composioSlugKey(current.displayName) === composioSlugKey(current.provider)) {
      byProvider.set(composioSlugKey(row.provider), {
        provider: row.provider,
        displayName: row.displayName,
      });
    }
  }
  return [...byProvider.values()];
}

/** Reuse a revoked/error row only when this provider has no live sibling. */
export function pickReusableConnection<T extends { id: string; status: string }>(
  rows: T[],
): T | undefined {
  if (rows.some((row) => row.status === "connected" || row.status === "pending")) {
    return undefined;
  }
  return rows.find((row) => row.status === "revoked" || row.status === "error");
}

export function planLiveConnectionSync(
  rows: PluginConnectionRow[],
  liveSlugs: string[],
): { connectIds: string[]; revokeIds: string[] } {
  const live = new Set(liveSlugs.map(composioSlugKey).filter(Boolean));
  const connectIds: string[] = [];
  const connectedProviders = new Set(
    rows.filter((row) => row.status === "connected").map((row) => composioSlugKey(row.provider)),
  );
  for (const slug of live) {
    if (connectedProviders.has(slug)) continue;
    const matches = rows.filter((row) => composioSlugKey(row.provider) === slug);
    // Recover in-flight pending/error rows only. A revoked sibling stays
    // revoked even when another row (or the upstream listing) is live for
    // the same slug — reviving it would reattach a dead providerRef.
    const reusable = matches.find((row) => row.status === "pending" || row.status === "error");
    if (!reusable) continue;
    connectIds.push(reusable.id);
    connectedProviders.add(slug);
  }
  const connectIdSet = new Set(connectIds);
  // Providers that already have a connected row before this sync. Extra pending
  // rows for those providers are additional-account attempts, not abandoned
  // first connects — keep them. Concurrent pendings with no connected row yet
  // still collapse to one connect + revoke the rest.
  const previouslyConnected = new Set(
    rows.filter((row) => row.status === "connected").map((row) => composioSlugKey(row.provider)),
  );
  const revokeIds = rows
    .filter((row) => {
      if (row.status !== "pending" && row.status !== "error") return false;
      if (connectIdSet.has(row.id)) return false;
      // Keep only in-flight additional-account pendings; clear abandoned errors
      // so live sync does not keep re-listing forever after a failed attempt.
      if (row.status === "pending" && previouslyConnected.has(composioSlugKey(row.provider))) {
        return false;
      }
      return true;
    })
    .map((row) => row.id);
  return { connectIds, revokeIds };
}

export class ComposioConnector implements ComposioProvider {
  private client: ComposioClient | undefined;
  private readonly apiKey: string | undefined;
  /** Only the keyless default connector shares the process-wide directory cache. */
  private readonly directoryCache: typeof composioToolkitDirectory;

  constructor(options: { apiKey?: string; client?: ComposioClient } = {}) {
    this.apiKey = options.apiKey;
    this.client = options.client;
    // The directory records which apps this project can sign in to, so each key needs its own.
    this.directoryCache =
      options.client || options.apiKey ? createToolkitDirectoryCache() : composioToolkitDirectory;
  }
  private readonly catalogSessions = new Map<string, string>();
  private readonly executeSessions = new Map<string, { sessionId: string; key: string }>();

  describe() {
    return {
      id: "composio",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { discover: true, oauth: true, secretsBrokered: true },
    };
  }

  async sessionFor(userId: string): Promise<ComposioSession> {
    const composio = await this.sdk();
    const existing = this.catalogSessions.get(userId);
    if (existing) {
      try {
        return await composio.sessions.use(existing);
      } catch {
        this.catalogSessions.delete(userId);
      }
    }
    const session = await composio.create(userId, {
      manageConnections: false,
      sandbox: { enable: false },
    });
    this.catalogSessions.set(userId, session.sessionId);
    return session;
  }

  /**
   * A toolkit whose every pinned account is no longer ACTIVE is left out of the
   * session: without a pin Composio would act as the user's newest active
   * account for that toolkit, which may be a different mailbox or workspace.
   */
  private async sessionForExecute(
    userId: string,
    connections: ConnectedConnector[],
  ): Promise<{
    session?: ComposioSession;
    reconnect: string[];
    connectedAccounts: Record<string, string[]>;
  }> {
    const requested = await this.canonicalizeToolkits(
      connections.map((connection) => connection.externalId),
    );
    const canonicalByKey = new Map(requested.map((toolkit) => [composioSlugKey(toolkit), toolkit]));
    const liveAccountIds = await this.listActiveAccountIds(userId, requested);
    const pinnedToolkits = new Set<string>();
    const accountIdsByToolkit = new Map<string, Set<string>>();
    for (const connection of connections) {
      const accountId = connection.providerRef?.trim();
      if (!accountId) continue;
      // No-auth and legacy rows store the toolkit slug rather than a remote
      // connected-account id. Only concrete account ids can scope a session.
      if (composioSlugKey(accountId) === composioSlugKey(connection.externalId)) continue;
      const toolkit = canonicalByKey.get(composioSlugKey(connection.externalId));
      if (!toolkit) continue;
      pinnedToolkits.add(toolkit);
      // Drop refs the provider no longer lists as ACTIVE so a revoked sibling
      // with a deleted account cannot fail the whole tool-router session.
      if (liveAccountIds && !liveAccountIds.has(accountId)) continue;
      const ids = accountIdsByToolkit.get(toolkit) ?? new Set<string>();
      ids.add(accountId);
      accountIdsByToolkit.set(toolkit, ids);
    }
    const reconnect = [...pinnedToolkits].filter((toolkit) => !accountIdsByToolkit.has(toolkit));
    const toolkits = requested.filter((toolkit) => !reconnect.includes(toolkit));
    const connectedAccounts: Record<string, string[]> = {};
    for (const [toolkit, ids] of accountIdsByToolkit) {
      connectedAccounts[toolkit] = [...ids].sort();
    }
    if (toolkits.length === 0) return { reconnect, connectedAccounts };
    const key = executeSessionKey(toolkits, connectedAccounts);
    const composio = await this.sdk();
    const existing = this.executeSessions.get(userId);
    if (existing?.key === key) {
      try {
        return {
          session: await composio.sessions.use(existing.sessionId),
          reconnect,
          connectedAccounts,
        };
      } catch {
        this.executeSessions.delete(userId);
      }
    }
    // Non-multi-account sessions cap connectedAccounts at one id per toolkit.
    // requireExplicitSelection would also break single-account / no-auth
    // execute paths that do not pass an account parameter.
    const needsMultiAccount = Object.values(connectedAccounts).some((ids) => ids.length >= 2);
    const session = await composio.create(userId, {
      manageConnections: false,
      sandbox: { enable: false },
      toolkits,
      ...(Object.keys(connectedAccounts).length > 0 ? { connectedAccounts } : {}),
      ...(needsMultiAccount
        ? {
            multiAccount: {
              enable: true,
              maxAccountsPerToolkit: 10,
              requireExplicitSelection: true,
            },
          }
        : {}),
    });
    this.executeSessions.set(userId, { sessionId: session.sessionId, key });
    return { session, reconnect, connectedAccounts };
  }

  async catalog(context: AdapterContext, query?: string): Promise<ConnectorCatalogItem[]> {
    const [directory, toolkits] = await Promise.all([
      this.directory(),
      this.connectedToolkits(context.userId),
    ]);
    // An expired account keeps its app listed so the user can still reconnect or remove it.
    const withAccount = toolkits.map((toolkit) => toolkit.slug);
    return filterCatalog(
      mergeCatalogWithConnected(directory, activeSlugs(toolkits), withAccount),
      query ?? "",
    ).map((item) => ({ ...item, connectorId: "composio" }));
  }

  async warmDirectory(): Promise<void> {
    await this.directory();
  }

  private async canonicalizeToolkits(toolkits: string[]): Promise<string[]> {
    const directory = await this.directory().catch(() => []);
    const canonical = new Map(directory.map((item) => [composioSlugKey(item.slug), item.slug]));
    const unique = new Map<string, string>();
    for (const toolkit of toolkits) {
      const trimmed = toolkit.trim();
      const key = composioSlugKey(trimmed);
      if (key && !unique.has(key)) {
        unique.set(key, canonical.get(key) ?? trimmed.toUpperCase());
      }
    }
    return [...unique.values()].sort();
  }

  private async directory(): Promise<ToolkitDirectoryEntry[]> {
    return this.directoryCache.get(() => this.loadDirectory());
  }

  private async loadDirectory(): Promise<ToolkitDirectoryEntry[]> {
    const session = await this.sessionFor("__rakazo_catalog__");
    const [toolkits, needsSetup] = await Promise.all([
      collectPages((cursor) => session.toolkits({ limit: 50, cursor })),
      // Without this lookup every app stays listed, as before.
      this.toolkitsNeedingSignInSetup().catch((error: unknown) => {
        getLogger().warn("composio sign-in setup lookup failed", {
          error: sanitizeIntegrationError(error),
        });
        return new Set<string>();
      }),
    ]);
    return toolkits.map((toolkit) => ({
      slug: toolkit.slug,
      name: toolkit.name,
      logo: toolkit.logo ?? null,
      noAuth: Boolean(toolkit.isNoAuth),
      ...(!toolkit.isNoAuth && needsSetup.has(composioSlugKey(toolkit.slug))
        ? { needsSignInSetup: true }
        : {}),
    }));
  }

  /**
   * Apps Composio has no managed sign-in for (Shopify, Twitter) connect only
   * once this project has its own auth config for them; until then hide them.
   */
  private async toolkitsNeedingSignInSetup(): Promise<Set<string>> {
    const composio = await this.sdk();
    const [toolkits, authConfigs] = await Promise.all([
      composio.toolkits.get({ limit: 1000 }),
      collectPages(async (cursor) => {
        const page = await composio.authConfigs.list({ limit: 100, cursor });
        return { items: page.items, cursor: page.nextCursor ?? undefined };
      }),
    ]);
    const configured = new Set(
      authConfigs
        .filter((config) => config.status === "ENABLED")
        .map((config) => composioSlugKey(config.toolkit.slug)),
    );
    return new Set(
      toolkits
        // A missing field is unknown, not "no managed sign-in".
        .filter((toolkit) => !toolkit.noAuth && toolkit.composioManagedAuthSchemes?.length === 0)
        .map((toolkit) => composioSlugKey(toolkit.slug))
        .filter((slug) => !configured.has(slug)),
    );
  }

  async listConnectedSlugs(userId: string): Promise<string[]> {
    return activeSlugs(await this.connectedToolkits(userId));
  }

  private async connectedToolkits(userId: string): Promise<ToolkitConnection[]> {
    const session = await this.sessionFor(userId);
    return collectPages((cursor) => session.toolkits({ isConnected: true, limit: 50, cursor }));
  }

  async listConnectedExternalIds(context: AdapterContext): Promise<string[]> {
    return this.listConnectedSlugs(context.userId);
  }

  async listReconnectRefs(context: AdapterContext): Promise<string[]> {
    return this.accountIds(context.userId, [], RECONNECT_STATUSES, { signal: context.signal });
  }

  /** The app's own actions, not the session tools that only search and run them. */
  async listAppTools(context: AdapterContext, externalId: string): Promise<ConnectorTool[]> {
    context.signal.throwIfAborted();
    const [toolkit] = await this.canonicalizeToolkits([externalId]);
    if (!toolkit) return [];
    const composio = await this.sdk();
    const tools: unknown[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      context.signal.throwIfAborted();
      if (seen.size >= 200 || (cursor && seen.has(cursor))) {
        throw new Error("App tool catalog pagination did not terminate");
      }
      if (cursor) seen.add(cursor);
      const page = await composio
        .getClient()
        .tools.list({ toolkit_slug: toolkit, limit: 200, cursor }, { signal: context.signal });
      tools.push(...page.items);
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return asConnectorTools(tools);
  }

  async discoverTools(context: AdapterContext): Promise<ConnectorTool[]> {
    const connections = connectedComposioConnections(context);
    if (connections.length === 0) return [];
    const { session } = await this.sessionForExecute(context.userId, connections);
    if (!session) return [];
    return asConnectorTools(await session.tools());
  }

  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    const executed = [];
    try {
      const connections = connectedComposioConnections(context);
      const { session, reconnect, connectedAccounts } = await this.sessionForExecute(
        context.userId,
        connections,
      );
      const toolkits = connections.map((connection) => connection.externalId);
      const stale = reconnect.find((toolkit) => callUsesToolkit(call, toolkit, toolkits));
      if (stale) {
        getLogger().warn("composio connected accounts need reconnect", {
          "composio.toolkits": stale,
        });
        yield {
          type: "error",
          message: `The ${stale} connection is no longer active. Ask the user to reconnect ${stale}.`,
        };
        return;
      }
      if (!session) {
        yield { type: "error", message: "No active Composio connection for this tool." };
        return;
      }
      const planned = expandComposioMultiExecute(call.tool, call.args ?? {});
      const unpinned = planned.find(
        (item) => item.account && !accountIsPinned(connectedAccounts, item.tool, item.account),
      );
      if (unpinned) {
        yield {
          type: "error",
          message: `The account requested for ${unpinned.tool} is not connected to this workspace.`,
        };
        return;
      }
      for (const item of planned) {
        const result = await session.execute(
          item.tool,
          item.args,
          item.account ? { account: item.account } : undefined,
        );
        // A failed or hook-blocked call can come back with an empty error.
        if (result.error || result.resultType !== "completed") {
          const logIds = collectLogIds(executed);
          yield {
            type: "error",
            message: sanitizeIntegrationError(
              composioResultError(result.error || `${item.tool} failed`, result.data),
            ),
            ...(logIds.length > 0 ? { logIds } : {}),
          };
          return;
        }
        executed.push(result);
      }
      const result =
        executed.length === 1
          ? executed[0]!
          : { data: executed.map((item) => item.data), error: null };
      const logIds = collectLogIds(executed.length === 1 ? result : executed);
      const logId = logIds[0] ?? "";
      yield {
        type: "result",
        data: {
          data: sanitizePayload(result.data),
          logId,
          ...(logIds.length > 1 ? { logIds: logIds.slice(1).map((id) => ({ logId: id })) } : {}),
        },
      };
    } catch (error) {
      const logIds = collectLogIds(executed);
      yield {
        type: "error",
        message: sanitizeIntegrationError(error),
        ...(logIds.length > 0 ? { logIds } : {}),
      };
    }
  }

  async begin(
    request: { provider: string; redirectUrl: string },
    context: AdapterContext,
  ): Promise<{ authorizationUrl: string | null; state: string }> {
    const session = await this.sessionFor(context.userId);
    try {
      const connectionRequest = await session.authorize(request.provider, {
        callbackUrl: request.redirectUrl,
      });
      if (!connectionRequest.redirectUrl) {
        const account = await connectionRequest.waitForConnection(20_000).catch(() => undefined);
        return {
          authorizationUrl: null,
          state: account?.id || connectionRequest.id || request.provider,
        };
      }
      return {
        authorizationUrl: connectionRequest.redirectUrl,
        state: connectionRequest.id || request.provider,
      };
    } catch (error) {
      if (isNoAuthToolkitError(error)) {
        return { authorizationUrl: null, state: request.provider };
      }
      if (isNoManagedAuthError(error)) {
        throw new ConnectorAuthUnavailableError({ cause: sanitizeIntegrationError(error) });
      }
      throw new Error(sanitizeIntegrationError(error));
    }
  }

  async connectionReady(context: AdapterContext, slug: string): Promise<boolean> {
    const session = await this.sessionFor(context.userId);
    const page = await session.toolkits({ search: slug, limit: 50 });
    const match = page.items.find((item) => composioSlugKey(item.slug) === composioSlugKey(slug));
    if (!match) return false;
    return Boolean(match.connection?.isActive) || Boolean(match.isNoAuth);
  }

  async complete(
    request: { state: string; code?: string },
    _context: AdapterContext,
  ): Promise<{ connectionRef: string }> {
    return { connectionRef: request.state };
  }

  async revoke(connectionRef: string, context: AdapterContext): Promise<void> {
    // Legacy rows may store a toolkit slug. Begin's browser OAuth state may be a
    // connection-request id. Resolve either to a concrete connected-account id
    // before delete — never pass a raw request id to connectedAccounts.delete.
    const requestOptions = { signal: context.signal };
    let accountId: string | undefined;
    try {
      const listed = await this.listConnectedAccountIds(
        context.userId,
        connectionRef,
        requestOptions,
      );
      accountId = listed[0];
      if (!accountId) {
        try {
          const { connectedAccounts } = await this.sdk();
          const account = await connectedAccounts.waitForConnection(connectionRef, 20_000);
          accountId = account?.id;
        } catch {
          // Not a resolvable request id; fall through to treat ref as an account id.
        }
      }
    } catch (error) {
      // Resolution failed before any DELETE — mark so callers can restore local retry state.
      if (error && typeof error === "object") {
        (error as { remoteRevokePreDelete?: boolean }).remoteRevokePreDelete = true;
      }
      throw error;
    }
    try {
      const { connectedAccounts } = await this.sdk();
      await connectedAccounts.delete(accountId ?? connectionRef, requestOptions);
    } catch (error) {
      // Already deleted upstream: the revoke goal is met.
      if (!isComposioNotFoundError(error)) throw error;
    }
  }

  async connectedAccountId(userId: string, slug: string): Promise<string | undefined> {
    const ids = await this.listConnectedAccountIds(userId, slug);
    return ids[0];
  }

  private async listActiveAccountIds(
    userId: string,
    toolkits: string[],
  ): Promise<Set<string> | null> {
    try {
      // A successful list is the allowlist, including empty. Only a thrown
      // lookup leaves filtering skipped so an outage does not strip every pin.
      return new Set(await this.accountIds(userId, toolkits, ["ACTIVE"]));
    } catch {
      return null;
    }
  }

  async listConnectedAccountIds(
    userId: string,
    slug: string,
    requestOptions?: { signal?: AbortSignal },
  ): Promise<string[]> {
    try {
      const ids = await this.accountIds(userId, [slug], ["ACTIVE"], requestOptions);
      if (ids.length > 0) return ids;
    } catch {
      // List may be unavailable; fall through to toolkit metadata.
    }
    if (requestOptions?.signal?.aborted) {
      throw requestOptions.signal.reason instanceof Error
        ? requestOptions.signal.reason
        : new Error("Aborted");
    }
    const session = await this.sessionFor(userId);
    const toolkits = await collectPages(
      (cursor) => session.toolkits({ isConnected: true, limit: 50, cursor }),
      MAX_ACCOUNT_PAGES,
    );
    const id = toolkits.find(
      (item) =>
        composioSlugKey(item.slug) === composioSlugKey(slug) && item.connection?.isActive === true,
    )?.connection?.connectedAccount?.id;
    return id ? [id] : [];
  }

  private async accountIds(
    userId: string,
    toolkits: string[],
    statuses: ConnectedAccountStatus[],
    requestOptions?: { signal?: AbortSignal },
  ): Promise<string[]> {
    const accounts = await collectPages(async (cursor) => {
      const { connectedAccounts } = await this.sdk();
      const page = await connectedAccounts.list(
        {
          userIds: [userId],
          ...(toolkits.length > 0 ? { toolkitSlugs: toolkits } : {}),
          statuses,
          ...(cursor ? { cursor } : {}),
        },
        requestOptions,
      );
      return { items: page.items ?? [], cursor: page.nextCursor ?? undefined };
    }, MAX_ACCOUNT_PAGES);
    return accounts.map((item) => item.id).filter((id): id is string => Boolean(id));
  }

  /**
   * Cancel an in-flight browser OAuth authorization by its connection-request id.
   * Composio uses the connected-account nanoid as the request id (INITIATED until
   * OAuth finishes); deleting it invalidates the authorization URL so a revoke-win
   * cannot leave an untracked remote after the user completes the orphaned link.
   */
  async cancelAuthorizationRequest(requestId: string, context: AdapterContext): Promise<void> {
    const id = requestId.trim();
    if (!id) return;
    // Connection-request ids are connected-account nanoids. Delete directly so a
    // revoke-win begin does not wait for OAuth to finish, and the authorization
    // URL cannot later create an untracked remote. Ignore missing ids.
    try {
      const { connectedAccounts } = await this.sdk();
      await connectedAccounts.delete(id, { signal: context.signal });
    } catch (error) {
      if (!isComposioNotFoundError(error)) throw error;
    }
  }

  /**
   * Map a begin() state (connection-request id, account id, or provider slug) to
   * the connected-account id revoke must delete. Prefer unused remotes so a
   * second Gmail connect does not reuse the first account's id.
   */
  async resolveConnectedAccountId(
    userId: string,
    slug: string,
    currentRef: string | null | undefined,
    excludeIds: string[] = [],
    _spaceId?: string,
  ): Promise<string | undefined> {
    const excluded = new Set(excludeIds.filter(Boolean));
    const current = currentRef?.trim() || undefined;
    const slugKey = composioSlugKey(slug);

    if (current && composioSlugKey(current) !== slugKey) {
      try {
        const { connectedAccounts } = await this.sdk();
        const account = await connectedAccounts.waitForConnection(current, 20_000);
        if (account?.id && !excluded.has(account.id)) return account.id;
      } catch {
        // Request id could not be resolved. Do not fall back to another connected
        // account — that can attach a sibling's remote identity to this row.
      }
      return undefined;
    }

    const ids = await this.listConnectedAccountIds(userId, slug);
    if (current && ids.includes(current) && !excluded.has(current)) return current;
    return ids.find((id) => !excluded.has(id));
  }

  /** The SDK loads on first use, so deployments without Composio never load it. */
  private async sdk(): Promise<ComposioClient> {
    if (!this.client) {
      const { Composio } = await import("@composio/core");
      this.client ??= new Composio(this.apiKey ? { apiKey: this.apiKey } : undefined);
    }
    return this.client;
  }
}

function isComposioNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; statusCode?: unknown };
  return candidate.status === 404 || candidate.statusCode === 404;
}

function connectedComposioConnections(context: AdapterContext): ConnectedConnector[] {
  return (
    context.connectedConnections?.filter((connection) => connection.connectorId === "composio") ??
    (context.connectedProviders ?? []).map((externalId) => ({
      id: `legacy:${externalId}`,
      connectorId: "composio",
      externalId,
      displayName: externalId,
    }))
  );
}

export function collectLogIds(value: unknown): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const record = node as Record<string, unknown>;
    for (const [key, nested] of Object.entries(record)) {
      if (
        (key === "logId" || key === "log_id") &&
        typeof nested === "string" &&
        nested &&
        !seen.has(nested)
      ) {
        seen.add(nested);
        ids.push(nested);
      } else {
        walk(nested);
      }
    }
  };
  walk(value);
  return ids;
}

export function isNoAuthToolkitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("ToolkitsIsNoAuth") || message.includes("does not require authentication")
  );
}

/** Composio has no managed OAuth app for the toolkit and the project has no auth config of its own. */
export function isNoManagedAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("ToolRouterV2_NoManagedAuth");
}

/**
 * COMPOSIO_MULTI_EXECUTE_TOOL reports a failed batch as "N out of M tools
 * failed" and puts each tool's real error in `data.results`. Keep those, or the
 * model cannot tell "message not found" apart from a broken integration.
 */
export function composioResultError(summary: string, data: unknown): string {
  const results = (data as { results?: unknown } | null | undefined)?.results;
  if (!Array.isArray(results)) return summary;
  const details = results.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as {
      tool_slug?: unknown;
      error?: unknown;
      response?: { error?: unknown } | null;
    };
    const error = [item.error, item.response?.error].find(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    if (!error) return [];
    const redacted = redactConnectorText(error);
    const detail = redacted.length > 500 ? `${redacted.slice(0, 500)}…` : redacted;
    return [typeof item.tool_slug === "string" ? `${item.tool_slug}: ${detail}` : detail];
  });
  if (details.length === 0) return summary;
  const shown = details.slice(0, 5);
  const more = details.length - shown.length;
  return `${summary}: ${shown.join("; ")}${more > 0 ? `; +${more} more` : ""}`;
}

export function sanitizeIntegrationError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactConnectorText(message);
}

const CREDENTIAL_FIELD_NAME =
  "composio[_-]?api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|client[_-]?secret|api[_-]?key|password|passwd|secret";

const CREDENTIAL_FIELD_KEY = new RegExp(`^(?:${CREDENTIAL_FIELD_NAME})$`, "i");

const CREDENTIAL_ASSIGNMENT = new RegExp(
  `(["']?\\b(?:${CREDENTIAL_FIELD_NAME})\\b["']?\\s*[=:]\\s*)` +
    `(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s,&;}]+(?:;(?![A-Za-z0-9_]+[=:])[^\\s,&;}]+)*)`,
  "gi",
);

function sanitizePayload(data: unknown): unknown {
  return redactConnectorData(data);
}

function redactConnectorData(data: unknown): unknown {
  if (typeof data === "string") return redactConnectorText(data);
  if (Array.isArray(data)) return data.map((item) => redactConnectorData(item));
  if (!data || typeof data !== "object") return data;
  const seen = new Map<string, number>();
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      distinctRedactedKey(redactSecretLiterals(key), seen),
      isCredentialField(key) ? "[redacted]" : redactConnectorData(value),
    ]),
  );
}

function distinctRedactedKey(key: string, seen: Map<string, number>): string {
  const count = (seen.get(key) ?? 0) + 1;
  seen.set(key, count);
  return count === 1 ? key : `${key}~${count}`;
}

function isCredentialField(key: string): boolean {
  return CREDENTIAL_FIELD_KEY.test(key);
}

function redactConnectorText(value: string): string {
  return redactSecretLiterals(
    value
      .replace(CREDENTIAL_ASSIGNMENT, '$1"[redacted]"')
      .replace(
        /COMPOSIO_API_KEY(?!\s*[=:])\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/gi,
        "COMPOSIO_API_KEY=[redacted]",
      ),
  );
}

function redactSecretLiterals(value: string): string {
  return value
    .replace(/ak_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/ck_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/sk-or-v1-[A-Za-z0-9]+/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}
