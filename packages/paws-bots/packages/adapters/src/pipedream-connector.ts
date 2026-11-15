import { createHmac } from "node:crypto";
import type {
  AdapterContext,
  ConnectorCall,
  ConnectorCatalogItem,
  ConnectorEvent,
  ConnectorTool,
  ManagedConnectorProvider,
} from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import { catalogToolPrefix } from "./approval-effect.js";
import { resolveAccountToolCall, scopeConnectorTools } from "./connector-accounts.js";
import { collectPages, filterCatalog } from "./connector-catalog.js";
import {
  combineSignals,
  redactConnectorPayload,
  sanitizeConnectorError,
} from "./connector-safety.js";
import {
  CATALOG_EXECUTE,
  catalogEntries,
  DIRECT_TOOL_LIMIT,
  executeLazyCatalogControl,
  isLazyCatalogControlRoute,
  lazyCatalogTools,
  resolveCatalogCall,
} from "./lazy-tool-catalog.js";
import type { RemoteTransportDependencies } from "./remote-mcp.js";
import { callRemoteMcpTool, listRemoteMcpTools } from "./remote-mcp.js";
import { isVitestRuntime } from "./test-runtime.js";
import { readBodyCapped, withAbort } from "./web-ssrf.js";

const API_BASE = "https://api.pipedream.com";
const MCP_ENDPOINT = "https://remote.mcp.pipedream.net/v3";
const DIRECTORY_TTL_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
export const MAX_PIPEDREAM_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface PipedreamConnectorConfig {
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment: "development" | "production";
  identitySecret: string;
}

export interface PipedreamEnvironmentValues {
  pipedreamClientId?: string;
  pipedreamClientSecret?: string;
  pipedreamProjectId?: string;
  pipedreamEnvironment?: string;
  encryptionKey: string;
}

export function pipedreamConfigFromEnv(
  values: PipedreamEnvironmentValues,
): PipedreamConnectorConfig {
  return {
    clientId: values.pipedreamClientId ?? "",
    clientSecret: values.pipedreamClientSecret ?? "",
    projectId: values.pipedreamProjectId ?? "",
    environment: values.pipedreamEnvironment === "production" ? "production" : "development",
    identitySecret: values.encryptionKey,
  };
}

export type PipedreamConnectorDependencies = RemoteTransportDependencies;

type PipedreamApp = {
  id: string;
  name_slug: string;
  name: string;
  img_src?: string;
};

type ApprovedAccount = { id: string; label: string; connectionId: string };

type PipedreamAccount = {
  id: string;
  healthy?: boolean;
  dead?: boolean;
  app?: PipedreamApp;
};

export function isPipedreamEnabled(config: Partial<PipedreamConnectorConfig>): boolean {
  return Boolean(
    config.clientId &&
      config.clientSecret &&
      config.projectId &&
      config.environment &&
      config.identitySecret &&
      !isVitestRuntime(),
  );
}

function securePipedreamConnectUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Pipedream did not return a secure HTTPS connect URL");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Pipedream did not return a secure HTTPS connect URL");
  }
  return url;
}

export class PipedreamConnector implements ManagedConnectorProvider {
  private accessToken?: { value: string; expiresAt: number };
  private accessTokenRequest?: Promise<string>;
  private directory?: { value: PipedreamApp[]; expiresAt: number };
  private directoryRequest?: Promise<PipedreamApp[]>;

  constructor(
    private readonly config: PipedreamConnectorConfig,
    private readonly dependencies: PipedreamConnectorDependencies = {},
  ) {}

  describe() {
    return {
      id: "pipedream",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { discover: true, oauth: true, secretsBrokered: true },
    };
  }

  async catalog(context: AdapterContext, query?: string): Promise<ConnectorCatalogItem[]> {
    const [apps, connected] = await Promise.all([
      this.apps(),
      this.listConnectedExternalIds(context),
    ]);
    const connectedSet = new Set(connected);
    return filterCatalog(
      apps.map((app) => ({
        connectorId: "pipedream",
        slug: app.name_slug,
        name: app.name,
        logo: app.img_src ?? null,
        connected: connectedSet.has(app.name_slug),
        noAuth: false,
      })),
      query ?? "",
    );
  }

  async needsReconnect(context: AdapterContext, externalId: string): Promise<boolean> {
    return approvedAccounts(context, externalId).length === 0;
  }

  async warmDirectory(): Promise<void> {
    await this.apps();
  }

  async listConnectedExternalIds(context: AdapterContext): Promise<string[]> {
    const accounts = await this.accounts(context);
    return [
      ...new Set(
        accounts
          .filter((account) => account.healthy !== false && account.dead !== true)
          .map((account) => account.app?.name_slug)
          .filter((slug): slug is string => Boolean(slug)),
      ),
    ];
  }

  private async allTools(context: AdapterContext): Promise<ConnectorTool[]> {
    const apps =
      context.connectedConnections
        ?.filter((connection) => connection.connectorId === "pipedream")
        .map((connection) => connection.externalId) ?? [];
    if (apps.length === 0) return [];
    const token = await this.token();
    const groups = await Promise.all(
      [...new Set(apps)].map(async (app) => {
        try {
          const accounts = approvedAccounts(context, app);
          return (
            await Promise.all(
              accounts.map(async (account) => {
                try {
                  const tools = await listRemoteMcpTools({
                    endpoint: MCP_ENDPOINT,
                    headers: this.mcpHeaders(context, app, account.id, token),
                    signal: context.signal,
                    fetch: this.dependencies.fetch,
                    resolveHostname: this.dependencies.resolveHostname,
                  });
                  return scopeConnectorTools(tools, {
                    id: account.connectionId,
                    connectorId: "pipedream",
                    externalId: app,
                    displayName: account.label,
                    providerRef: account.id,
                  });
                } catch (error) {
                  getLogger().error(
                    "pipedream account discovery failed",
                    sanitizeConnectorError(error),
                    { "connector.app": app, "connection.id": account.connectionId },
                  );
                  return [];
                }
              }),
            )
          ).flat();
        } catch (error) {
          // A single unavailable app must not hide tools from other connections.
          getLogger().error(
            `pipedream discovery failed for app ${app}:`,
            sanitizeConnectorError(error),
          );
          return [];
        }
      }),
    );
    return groups.flat();
  }

  async discoverTools(context: AdapterContext): Promise<ConnectorTool[]> {
    const tools = await this.allTools(context);
    if (tools.length <= DIRECT_TOOL_LIMIT) return tools;
    return lazyCatalogTools(
      catalogToolPrefix("pipedream"),
      "pipedream",
      "app",
      catalogEntries(tools),
    );
  }

  async resolveCall(
    call: ConnectorCall,
    context: AdapterContext,
  ): Promise<{ call: ConnectorCall; tool: ConnectorTool } | undefined> {
    if (!call.route) return resolveAccountToolCall(call, await this.allTools(context));
    // Wrappers have no resourceId; real tools always do.
    if (call.route?.resourceId || call.route?.toolName !== CATALOG_EXECUTE) return undefined;
    return resolveCatalogCall(call, catalogEntries(await this.allTools(context)));
  }

  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    if (isLazyCatalogControlRoute(call.route)) {
      try {
        yield* executeLazyCatalogControl(
          call,
          catalogEntries(await this.allTools(context)),
          (resolved) => this.execute(resolved, context),
        );
      } catch (error) {
        yield { type: "error", message: sanitizeConnectorError(error) };
      }
      return;
    }
    const app = call.route?.resourceId;
    if (!app) {
      yield { type: "error", message: "Pipedream app route is missing" };
      return;
    }
    let token: string | undefined;
    try {
      const accounts = approvedAccounts(context, app);
      const selected = call.route?.connectionId ?? call.connectionId;
      const account = selected
        ? accounts.find(({ connectionId }) => connectionId === selected)
        : accounts.length === 1
          ? accounts[0]
          : undefined;
      if (
        !account ||
        (call.route?.resourceRevision !== undefined && call.route.resourceRevision !== account.id)
      ) {
        yield {
          type: "error",
          message:
            accounts.length === 0
              ? `No connected ${app} account can be identified. Reconnect ${app}.`
              : "The selected connected account is unavailable. Reload the account's tools.",
        };
        return;
      }
      token = await this.token();
      const result = await callRemoteMcpTool(
        {
          endpoint: MCP_ENDPOINT,
          headers: this.mcpHeaders(context, app, account.id, token),
          signal: context.signal,
          fetch: this.dependencies.fetch,
          resolveHostname: this.dependencies.resolveHostname,
        },
        call.route?.toolName ?? call.tool,
        call.args,
      );
      yield {
        type: "result",
        data: redactConnectorPayload(result, [token, this.config.clientSecret]),
      };
    } catch (error) {
      yield {
        type: "error",
        message: sanitizeConnectorError(
          error,
          [token, this.config.clientSecret].filter((value): value is string => Boolean(value)),
        ),
      };
    }
  }

  async begin(
    request: { provider: string; redirectUrl: string },
    context: AdapterContext,
  ): Promise<{ authorizationUrl: string | null; state: string }> {
    const response = await this.request<{ connect_link_url: string }>(
      `/v1/connect/${encodeURIComponent(this.config.projectId)}/tokens`,
      {
        method: "POST",
        body: JSON.stringify({
          external_user_id: this.externalUserId(context),
          success_redirect_uri: request.redirectUrl,
          error_redirect_uri: request.redirectUrl,
          scope: "connect:accounts:read connect:accounts:write",
        }),
      },
      context.signal,
    );
    const url = securePipedreamConnectUrl(response.connect_link_url);
    url.searchParams.set("app", request.provider);
    return { authorizationUrl: url.toString(), state: request.provider };
  }

  async complete(request: { state: string }): Promise<{ connectionRef: string }> {
    return { connectionRef: request.state };
  }

  /**
   * Prefer a concrete Pipedream account id over the app slug so multi-account
   * revoke can target one authorization. spaceId is required for the hashed
   * external user id Pipedream uses to scope accounts.
   */
  async resolveConnectedAccountId(
    userId: string,
    slug: string,
    currentRef: string | null | undefined,
    excludeIds: string[] = [],
    spaceId?: string,
  ): Promise<string | undefined> {
    const excluded = new Set(excludeIds.filter(Boolean));
    const current = currentRef?.trim() || undefined;
    if (!spaceId) {
      return current && current !== slug && !excluded.has(current) ? current : undefined;
    }
    // Concrete account ids are already authoritative; do not reassign them.
    if (current && current !== slug) {
      return excluded.has(current) ? undefined : current;
    }
    const context = {
      userId,
      spaceId,
      signal: AbortSignal.timeout(30_000),
    } as AdapterContext;
    const accounts = await this.accounts(context, slug);
    const ids = accounts
      .filter((account) => account.healthy !== false && account.dead !== true)
      .map((account) => account.id)
      .filter(Boolean);
    return ids.find((id) => !excluded.has(id));
  }

  async connectionReady(context: AdapterContext, externalId: string): Promise<boolean> {
    const accounts = await this.accounts(context, externalId);
    return accounts.some(
      (account) =>
        account.app?.name_slug === externalId && account.healthy !== false && account.dead !== true,
    );
  }

  async revoke(externalId: string, context: AdapterContext): Promise<void> {
    let accounts: PipedreamAccount[];
    try {
      accounts = await this.accounts(context);
    } catch (error) {
      // Listing failed before any DELETE — mark so callers can restore local retry state.
      if (error && typeof error === "object") {
        (error as { remoteRevokePreDelete?: boolean }).remoteRevokePreDelete = true;
      }
      throw error;
    }
    const targets = accounts.filter(
      (account) => account.id === externalId || account.app?.name_slug === externalId,
    );
    await Promise.all(
      targets.map((account) =>
        this.request(
          `/v1/connect/${encodeURIComponent(this.config.projectId)}/accounts/${encodeURIComponent(account.id)}`,
          { method: "DELETE" },
          context.signal,
        ),
      ),
    );
  }

  /**
   * Delete remote accounts for `slug` that no local row still references. Used when a
   * begin loses a race to revoke and only the app slug is available — never revoke by
   * slug alone, or every sibling authorization would be deleted.
   */
  async revokeUnreferencedAccounts(
    slug: string,
    keepAccountIds: string[],
    context: AdapterContext,
  ): Promise<void> {
    const keep = new Set(keepAccountIds.filter(Boolean));
    const accounts = await this.accounts(context, slug);
    const orphans = accounts.filter(
      (account) =>
        account.app?.name_slug === slug &&
        account.healthy !== false &&
        account.dead !== true &&
        !keep.has(account.id),
    );
    await Promise.all(
      orphans.map((account) =>
        this.request(
          `/v1/connect/${encodeURIComponent(this.config.projectId)}/accounts/${encodeURIComponent(account.id)}`,
          { method: "DELETE" },
          context.signal,
        ),
      ),
    );
  }

  /** Pipedream keys connected accounts by this stateless ID; changing it orphans them. */
  private externalUserId(context: AdapterContext): string {
    return `rkz_${createHmac("sha256", this.config.identitySecret)
      .update(`${context.spaceId}:${context.userId}`)
      .digest("hex")}`;
  }

  private mcpHeaders(
    context: AdapterContext,
    app: string,
    accountId: string,
    accessToken: string,
  ): Record<string, string> {
    return {
      authorization: `Bearer ${accessToken}`,
      "x-pd-project-id": this.config.projectId,
      "x-pd-environment": this.config.environment,
      "x-pd-external-user-id": this.externalUserId(context),
      "x-pd-app-slug": app,
      "x-pd-account-id": accountId,
    };
  }

  private async apps(): Promise<PipedreamApp[]> {
    if (this.directory && this.directory.expiresAt > Date.now()) return this.directory.value;
    if (this.directoryRequest) return this.directoryRequest;
    this.directoryRequest = this.loadApps();
    try {
      return await this.directoryRequest;
    } finally {
      this.directoryRequest = undefined;
    }
  }

  private async loadApps(): Promise<PipedreamApp[]> {
    const apps: PipedreamApp[] = [];
    let after: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const query = new URLSearchParams({ limit: "100", has_actions: "true" });
      if (after) query.set("after", after);
      const response = await this.request<{
        data?: PipedreamApp[];
        page_info?: { end_cursor?: string };
      }>(`/v1/connect/apps?${query}`);
      apps.push(...(response.data ?? []));
      after = response.page_info?.end_cursor;
      if (!after || apps.length >= 5_000) break;
    }
    this.directory = { value: apps, expiresAt: Date.now() + DIRECTORY_TTL_MS };
    return apps;
  }

  private async accounts(context: AdapterContext, app?: string): Promise<PipedreamAccount[]> {
    return collectPages(async (after) => {
      const query = new URLSearchParams({
        external_user_id: this.externalUserId(context),
        limit: "100",
      });
      if (app) query.set("app", app);
      if (after) query.set("after", after);
      const response = await this.request<{
        data?: PipedreamAccount[];
        page_info?: { end_cursor?: string };
      }>(
        `/v1/connect/${encodeURIComponent(this.config.projectId)}/accounts?${query}`,
        {},
        context.signal,
      );
      return { items: response.data ?? [], cursor: response.page_info?.end_cursor };
    }, 20);
  }

  private async request<T = unknown>(
    path: string,
    init: RequestInit = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const token = await this.token();
    const requestAbort = combineSignals(signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
    const response = await (this.dependencies.fetch ?? globalThis.fetch)(`${API_BASE}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-pd-environment": this.config.environment,
        ...init.headers,
      },
      signal: requestAbort,
    });
    if (response.status === 401) this.accessToken = undefined;
    const body = await readPipedreamBody(response, requestAbort);
    if (!response.ok) {
      throw new Error(
        sanitizeConnectorError(`Pipedream returned HTTP ${response.status}: ${body}`, [token]),
      );
    }
    return (body ? JSON.parse(body) : {}) as T;
  }

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000) {
      return this.accessToken.value;
    }
    if (this.accessTokenRequest) return this.accessTokenRequest;
    this.accessTokenRequest = this.fetchToken();
    try {
      return await this.accessTokenRequest;
    } finally {
      this.accessTokenRequest = undefined;
    }
  }

  private async fetchToken(): Promise<string> {
    const requestAbort = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await (this.dependencies.fetch ?? globalThis.fetch)(
      `${API_BASE}/v1/oauth/token`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "client_credentials",
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          scope: "connect:*",
        }),
        signal: requestAbort,
      },
    );
    const text = await readPipedreamBody(response, requestAbort);
    const body = (response.ok && text ? JSON.parse(text) : {}) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!response.ok || !body.access_token) {
      throw new Error(`Pipedream authentication failed: ${body.error ?? response.status}`);
    }
    this.accessToken = {
      value: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 3_600) * 1_000,
    };
    return body.access_token;
  }
}

/**
 * The accounts this workspace approved for `app`, so Pipedream never picks one
 * itself. A row holding only the app slug cannot name its account and is skipped:
 * the run context omits revoked and pending rows, so it cannot tell which remote
 * account such a row stands for.
 */
function approvedAccounts(context: AdapterContext, app: string): ApprovedAccount[] {
  const approved = new Map<string, ApprovedAccount>();
  for (const connection of context.connectedConnections ?? []) {
    if (connection.connectorId !== "pipedream" || connection.externalId !== app) continue;
    const ref = connection.providerRef?.trim();
    if (ref && ref !== app && !approved.has(ref)) {
      approved.set(ref, { id: ref, label: connection.displayName, connectionId: connection.id });
    }
  }
  return [...approved.values()];
}

async function readPipedreamBody(response: Response, signal: AbortSignal): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_PIPEDREAM_RESPONSE_BYTES) {
    const cancel = response.body?.cancel() ?? Promise.resolve();
    // A hanging cancel must not outlive the shared deadline.
    await withAbort(
      cancel.catch(() => undefined),
      signal,
    ).catch(() => undefined);
    throw new Error("Pipedream response is too large.");
  }
  try {
    const bytes = await readBodyCapped(response, MAX_PIPEDREAM_RESPONSE_BYTES, signal);
    return new TextDecoder().decode(bytes);
  } catch (error) {
    if (error instanceof Error && error.message === "Response is too large") {
      throw new Error("Pipedream response is too large.");
    }
    throw error;
  }
}
