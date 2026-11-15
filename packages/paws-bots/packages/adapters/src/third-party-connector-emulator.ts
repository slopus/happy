import { isIP } from "node:net";
import type { ResolveHostname } from "./remote-mcp.js";

type EmulatorRecord =
  | { provider: "pipedream"; operation: string; app?: string }
  | { provider: "catalog"; operation: "search"; query: string }
  | {
      provider: "mcp";
      operation: string;
      host: string;
      authenticated?: boolean;
      args?: Record<string, unknown>;
    }
  | { provider: "openapi"; operation: string; path: string; authenticated: boolean }
  | { provider: "graphql"; operation: string; authenticated: boolean };

/** Expected Executor test bearer. Compared at the boundary; never written into records. */
const EXPECTED_EXECUTOR_BEARER = "Bearer fake-executor-credential-value";

const PIPEDREAM_APPS = [
  { id: "app-linear", name_slug: "linear", name: "Linear" },
  { id: "app-airtable", name_slug: "airtable", name: "Airtable" },
];

/** Deterministic HTTP/MCP boundary emulator used by integration and browser journeys. */
export class ThirdPartyConnectorEmulator {
  readonly records: EmulatorRecord[] = [];
  readonly resolveHostname: ResolveHostname = async () => [{ address: "203.0.113.10", family: 4 }];

  private readonly connectedApps = new Map<string, Set<string>>();
  private readonly accountOwners = new Map<string, { externalUserId: string; app: string }>();
  private readonly pendingUsers = new Set<string>();

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = urlFromPinnedFetch(input, init);
    if (url.hostname === "api.pipedream.com") return this.pipedream(url, init);
    if (url.hostname === "remote.mcp.pipedream.net" || url.hostname === "treg.to") {
      return this.mcp(url, init);
    }
    if (url.hostname === "mcp.example.test" || url.hostname === "executor.example.test") {
      return this.mcp(url, init);
    }
    if (url.hostname === "api.example.test") return this.openapi(url, init);
    if (url.hostname === "graphql.example.test") return this.graphql(url, init);
    if (url.hostname === "catalog.example.test") return this.catalog(url);
    throw new Error(`Third-party connector emulator received unexpected URL ${url}`);
  };

  private async catalog(url: URL): Promise<Response> {
    if (url.pathname !== "/api/search") return new Response(null, { status: 404 });
    const query = url.searchParams.get("q") ?? "";
    this.records.push({ provider: "catalog", operation: "search", query });
    if (!query.toLowerCase().includes("github")) return Response.json({ results: [] });
    return Response.json({
      results: [
        {
          domain: "github.com",
          name: "GitHub",
          description: "Repository automation surfaces",
          url: "https://integrations.example.test/github.com/",
          surfaces: [
            {
              kind: "mcp",
              slug: "github-mcp",
              url: "https://mcp.example.test/mcp",
              auth: { kind: "token", header: "Authorization: Bearer {token}" },
            },
            {
              kind: "openapi",
              slug: "github-openapi",
              url: "https://api.example.test/openapi.json",
              auth: { kind: "token", header: "Authorization: Bearer {token}" },
            },
            { kind: "graphql", slug: "github-graphql", url: "https://api.github.test/graphql" },
            { kind: "cli", slug: "github-cli" },
          ],
        },
      ],
    });
  }

  private async pipedream(url: URL, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? "GET";
    if (url.pathname === "/v1/oauth/token") {
      this.records.push({ provider: "pipedream", operation: "token" });
      return Response.json({ access_token: "fake-pipedream-access-token", expires_in: 3_600 });
    }
    if (url.pathname === "/v1/connect/apps") {
      this.records.push({ provider: "pipedream", operation: "catalog" });
      return Response.json({ data: PIPEDREAM_APPS, page_info: {} });
    }
    if (url.pathname.endsWith("/tokens") && method === "POST") {
      const body = parseBody(init?.body);
      const externalUserId = String(body.external_user_id ?? "");
      this.pendingUsers.add(externalUserId);
      this.records.push({ provider: "pipedream", operation: "begin" });
      return Response.json({ connect_link_url: "https://pipedream.example.test/connect" });
    }
    if (url.pathname.endsWith("/accounts") && method === "GET") {
      const externalUserId = url.searchParams.get("external_user_id") ?? "";
      const requestedApp = url.searchParams.get("app") ?? undefined;
      if (requestedApp && this.pendingUsers.delete(externalUserId)) {
        const connected = this.connectedApps.get(externalUserId) ?? new Set<string>();
        connected.add(requestedApp);
        this.connectedApps.set(externalUserId, connected);
      }
      const apps = [...(this.connectedApps.get(externalUserId) ?? [])].filter(
        (app) => !requestedApp || app === requestedApp,
      );
      const data = apps.map((app) => {
        const id = `account-${app}`;
        this.accountOwners.set(id, { externalUserId, app });
        return {
          id,
          healthy: true,
          app: PIPEDREAM_APPS.find((candidate) => candidate.name_slug === app),
        };
      });
      this.records.push({ provider: "pipedream", operation: "accounts", app: requestedApp });
      return Response.json({ data, page_info: {} });
    }
    const accountId = url.pathname.match(/\/accounts\/([^/]+)$/)?.[1];
    if (accountId && method === "DELETE") {
      const owner = this.accountOwners.get(decodeURIComponent(accountId));
      if (owner) this.connectedApps.get(owner.externalUserId)?.delete(owner.app);
      this.records.push({ provider: "pipedream", operation: "revoke", app: owner?.app });
      return new Response(null, { status: 204 });
    }
    return Response.json(
      { error: `Unhandled Pipedream request ${method} ${url.pathname}` },
      {
        status: 404,
      },
    );
  }

  private async mcp(url: URL, init?: RequestInit): Promise<Response> {
    const request = parseBody(init?.body);
    const method = String(request.method ?? "");
    const id = request.id;
    const headers = new Headers(init?.headers);
    const app = headers.get("x-pd-app-slug") ?? undefined;
    const authorization = headers.get("authorization");
    // Validate bearer at the boundary; persist only the boolean, never the secret.
    const authenticated =
      url.hostname === "executor.example.test"
        ? authorization === EXPECTED_EXECUTOR_BEARER
        : Boolean(authorization?.startsWith("Bearer ") && authorization.length > "Bearer ".length);
    if (method === "notifications/initialized") return new Response(null, { status: 202 });
    if (method === "initialize") {
      return jsonRpc(id, {
        protocolVersion: String(
          (request.params as Record<string, unknown> | undefined)?.protocolVersion ?? "2025-06-18",
        ),
        capabilities: { tools: {} },
        serverInfo: { name: "rakazo-third-party-emulator", version: "1.0.0" },
      });
    }
    if (method === "tools/list") {
      this.records.push({
        provider: "mcp",
        operation: "tools/list",
        host: url.hostname,
        authenticated,
      });
      return jsonRpc(id, {
        tools: [
          {
            name: "notes.write",
            description: "Write a deterministic emulated note",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        ],
      });
    }
    if (method === "tools/call") {
      const params = (request.params ?? {}) as Record<string, unknown>;
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      this.records.push({
        provider: "mcp",
        operation: String(params.name ?? "unknown"),
        host: url.hostname,
        authenticated,
        args,
      });
      const result = { ok: true, app, text: args.text ?? null };
      return jsonRpc(id, {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      });
    }
    return jsonRpcError(id, -32601, `Unhandled MCP method ${method}`);
  }

  private async openapi(url: URL, init?: RequestInit): Promise<Response> {
    if (url.pathname === "/openapi.json") {
      return Response.json({
        openapi: "3.1.0",
        servers: [{ url: "https://api.example.test/v1" }],
        paths: {
          "/contacts/{contactId}": {
            get: {
              operationId: "getContact",
              summary: "Get one contact",
              parameters: [
                {
                  name: "contactId",
                  in: "path",
                  required: true,
                  schema: { type: "string" },
                },
              ],
            },
          },
        },
      });
    }
    const authenticated = new Headers(init?.headers).has("authorization");
    this.records.push({
      provider: "openapi",
      operation: init?.method ?? "GET",
      path: url.pathname,
      authenticated,
    });
    return Response.json({ ok: true, contactId: url.pathname.split("/").at(-1) });
  }

  private async graphql(url: URL, init?: RequestInit): Promise<Response> {
    const authenticated = new Headers(init?.headers).has("authorization");
    const body = parseBody(init?.body);
    const query = typeof body.query === "string" ? body.query : "";
    if (query.includes("__schema")) {
      this.records.push({ provider: "graphql", operation: "introspect", authenticated });
      return Response.json({
        data: {
          __schema: {
            queryType: { name: "Query" },
            mutationType: { name: "Mutation" },
            types: [
              {
                kind: "OBJECT",
                name: "Query",
                fields: [
                  {
                    name: "hero",
                    description: "Fetch a hero",
                    args: [
                      {
                        name: "episode",
                        description: "Episode code",
                        type: { kind: "ENUM", name: "Episode", ofType: null },
                        defaultValue: null,
                      },
                    ],
                    type: {
                      kind: "OBJECT",
                      name: "Character",
                      ofType: null,
                    },
                  },
                  {
                    name: "hello",
                    description: "Say hello",
                    args: [],
                    type: { kind: "SCALAR", name: "String", ofType: null },
                  },
                ],
                inputFields: null,
                enumValues: null,
              },
              {
                kind: "OBJECT",
                name: "Mutation",
                fields: [
                  {
                    name: "createNote",
                    description: "Create a note",
                    args: [
                      {
                        name: "text",
                        type: {
                          kind: "NON_NULL",
                          name: null,
                          ofType: { kind: "SCALAR", name: "String", ofType: null },
                        },
                        defaultValue: null,
                      },
                    ],
                    type: { kind: "SCALAR", name: "String", ofType: null },
                  },
                ],
                inputFields: null,
                enumValues: null,
              },
              {
                kind: "OBJECT",
                name: "Character",
                fields: [
                  {
                    name: "name",
                    args: [],
                    type: { kind: "SCALAR", name: "String", ofType: null },
                  },
                  {
                    name: "appearsIn",
                    args: [],
                    type: {
                      kind: "LIST",
                      name: null,
                      ofType: { kind: "ENUM", name: "Episode", ofType: null },
                    },
                  },
                ],
                inputFields: null,
                enumValues: null,
              },
              {
                kind: "ENUM",
                name: "Episode",
                fields: null,
                inputFields: null,
                enumValues: [{ name: "NEWHOPE" }, { name: "EMPIRE" }, { name: "JEDI" }],
              },
              { kind: "SCALAR", name: "String", fields: null, inputFields: null, enumValues: null },
            ],
          },
        },
      });
    }
    this.records.push({
      provider: "graphql",
      operation: typeof body.operationName === "string" ? body.operationName : "execute",
      authenticated,
    });
    return Response.json({ data: { ok: true, path: url.pathname } });
  }
}

function urlFromPinnedFetch(input: string | URL | Request, init?: RequestInit): URL {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname) === 0) return url;
  const host = new Headers(init?.headers).get("host");
  if (!host) return url;
  const routed = new URL(url);
  routed.host = host;
  return routed;
}

function parseBody(body: RequestInit["body"] | undefined): Record<string, unknown> {
  if (typeof body === "string") return JSON.parse(body) as Record<string, unknown>;
  if (body instanceof Uint8Array) {
    return JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
  }
  return {};
}

function jsonRpc(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

function jsonRpcError(id: unknown, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } });
}
