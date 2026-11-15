import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { Agent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MCP_CLOSE_TIMEOUT_MS } from "./mcp-close.js";
import { StoredMcpOAuthProvider } from "./mcp-oauth.js";
import {
  McpSession,
  McpStdioLaunchError,
  mcpStdioRefusal,
  secureFetch,
  validateUrl,
  withEndpointOriginFallback,
} from "./mcp-transport.js";

afterEach(() => vi.unstubAllGlobals());

const TEST_NETWORK = {
  // Read the global per call so a fetch stubbed after construction still wins.
  fetch: (input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init),
  resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
};

function logicalHref(input: string | URL | Request, init?: RequestInit): string {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? String(input) : input.url,
  );
  const host = new Headers(input instanceof Request ? input.headers : init?.headers).get("host");
  if (host) url.host = host;
  return url.href;
}

describe("MCP transport seam", () => {
  it.each(["init", "request"] as const)(
    "keeps the %s abort signal connected after GC while an SSE body is open",
    async (kind) => {
      setFlagsFromString("--expose-gc");
      const gc = runInNewContext("gc") as () => void;
      setFlagsFromString("--no-expose-gc");
      const controller = new AbortController();
      let forwarded: AbortSignal | null | undefined;
      const fetch = secureFetch(
        new URL("https://mcp.example.test/mcp"),
        {},
        {},
        {
          ...TEST_NETWORK,
          fetch: async (_input, init) => {
            forwarded = init?.signal;
            return new Response(
              new ReadableStream({
                start(stream) {
                  init?.signal?.addEventListener("abort", () => stream.error(init.signal?.reason), {
                    once: true,
                  });
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            );
          },
        },
      );
      // Drop every Request before GC; retain only the caller's controller and body.
      const response = await (async () => {
        const init = { signal: controller.signal, headers: { accept: "text/event-stream" } };
        return kind === "init"
          ? fetch("https://mcp.example.test/mcp", init)
          : fetch(new Request("https://mcp.example.test/mcp", init));
      })();
      const reading = response
        .body!.getReader()
        .read()
        .catch((error: unknown) => error);
      try {
        for (let i = 0; i < 10; i += 1) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          gc();
        }
        controller.abort(new Error("session closed"));
        expect(forwarded?.aborted).toBe(true);
        expect(await reading).toEqual(new Error("session closed"));
      } finally {
        await fetch.close();
      }
    },
  );

  it("honors an explicit signal override, including null, for a Request input", async () => {
    const original = new AbortController();
    const override = new AbortController();
    const seen: Array<AbortSignal | null | undefined> = [];
    const fetch = secureFetch(
      new URL("https://mcp.example.test/mcp"),
      {},
      {},
      {
        ...TEST_NETWORK,
        fetch: async (_input, init) => {
          seen.push(init?.signal);
          return new Response(null);
        },
      },
    );
    try {
      const request = new Request("https://mcp.example.test/mcp", { signal: original.signal });
      await fetch(request, { signal: override.signal });
      await fetch(request, { signal: null });
      expect(seen).toEqual([override.signal, null]);
    } finally {
      await fetch.close();
    }
  });

  it("bounds both SDK and dispatcher close, and observes a late cleanup rejection", async () => {
    const session = new McpSession();
    await session.connectRemote({
      url: "https://mcp.example.test/mcp",
      network: {
        ...TEST_NETWORK,
        fetch: async (input, init) => {
          const message = await new Request(input, init).json();
          if (message.method !== "initialize") return new Response(null, { status: 202 });
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              serverInfo: { name: "test", version: "1" },
            },
          });
        },
      },
    });
    vi.useFakeTimers();
    const clientClose = vi
      .spyOn(session.client, "close")
      .mockImplementation(() => new Promise(() => {}));
    let rejectClose: ((error: Error) => void) | undefined;
    const dispatcherClose = vi.spyOn(Agent.prototype, "close").mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectClose = reject;
        }),
    );
    try {
      const closing = session.close();
      await vi.advanceTimersByTimeAsync(MCP_CLOSE_TIMEOUT_MS);
      expect(clientClose).toHaveBeenCalledOnce();
      expect(dispatcherClose).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(MCP_CLOSE_TIMEOUT_MS);
      await closing;
      rejectClose!(new Error("late close failure"));
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      clientClose.mockRestore();
      dispatcherClose.mockRestore();
      vi.useRealTimers();
      await session.close();
    }
  });

  it("rejects unsafe URLs and oversized URLs before network access", () => {
    expect(() => validateUrl("http://remote.example/mcp")).toThrow("HTTPS");
    expect(() => validateUrl("https://user:pass@example.com/mcp")).toThrow("credentials");
    expect(() => validateUrl(`https://example.com/${"x".repeat(2_100)}`)).toThrow("exceeds");
    expect(() => validateUrl("http://127.0.0.1:1234/mcp")).toThrow("HTTPS");
    expect(() => validateUrl("http://10.0.0.8:3927/mcp")).toThrow("HTTPS");
    expect(validateUrl("http://10.0.0.8:3927/mcp", { allowPrivateEndpoint: true }).hostname).toBe(
      "10.0.0.8",
    );
    expect(validateUrl("http://127.0.0.1:1234/mcp", { allowHttpLocalhost: true }).hostname).toBe(
      "127.0.0.1",
    );
  });

  it("gates stdio by exact command allowlist", async () => {
    const session = new McpSession();
    await expect(
      session.connectStdio({
        command: process.execPath,
        allowedCommands: ["/definitely-not-node"],
      }),
    ).rejects.toThrow("allowlist");
    await session.close();
    assert.ok(true);
  });

  it("explains a stdio process that exits with the tail of its stderr", async () => {
    const session = new McpSession();
    const error = await session
      .connectStdio({
        command: process.execPath,
        args: [
          "-e",
          "process.stderr.write('\\u001b[31mnoise\\u001b[0m\\n'.repeat(500)); console.error('sh: gmail-mcp: not found'); process.exit(127)",
        ],
        allowedCommands: [process.execPath],
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McpStdioLaunchError);
    const launch = error as McpStdioLaunchError;
    expect(launch.message).toMatch(
      /Connection closed[\s\S]*stderr: [\s\S]*sh: gmail-mcp: not found$/,
    );
    expect(launch.stderr).not.toContain("\u001b");
    expect(launch.stderr.length).toBeLessThanOrEqual(4_096);
    await session.close();
  });

  it("launches only package bins that Rakazo installed", async () => {
    const session = new McpSession();
    await expect(
      session.connectStdio({
        command: "npx",
        allowedCommands: ["npx"],
        installedBin: { binPath: process.execPath },
      }),
    ).rejects.toThrow("not installed by Rakazo");
    await expect(
      session.connectStdio({ command: "npx", args: ["-c", "echo hi"], allowedCommands: ["npx"] }),
    ).rejects.toThrow("npx only launches");
    // The launcher itself must still be allowlisted.
    await expect(
      session.connectStdio({
        command: "npx",
        allowedCommands: [],
        installedBin: { binPath: process.execPath },
      }),
    ).rejects.toThrow("allowlist");
    await session.close();
  });

  const RUNNERS = [
    "bunx",
    "pnpx",
    "uvx",
    "pipx",
    "/usr/local/bin/pnpm",
    "npm",
    "yarn",
    "bun",
    "deno",
    "uv",
    "pnpm.cmd",
    "BUNX.exe",
  ];

  it.each(RUNNERS)("refuses package runner %s even when allowlisted", async (command) => {
    expect(mcpStdioRefusal(command, { stdioEnabled: true, allowedCommands: [command] })).toBe(
      "Only npx can launch packages here",
    );
    const session = new McpSession();
    await expect(
      session.connectStdio({ command, args: ["dlx", "pkg"], allowedCommands: [command] }),
    ).rejects.toThrow("Only npx can launch packages here");
    await session.close();
  });

  it("still allows npx and plain allowlisted binaries", () => {
    const policy = { stdioEnabled: true, allowedCommands: ["npx", "/opt/mcp/server", "node"] };
    expect(mcpStdioRefusal("npx", policy)).toBeUndefined();
    expect(mcpStdioRefusal("/opt/mcp/server", policy)).toBeUndefined();
    expect(mcpStdioRefusal("node", policy)).toBeUndefined();
  });

  it("rejects remote endpoints that resolve to a private address", async () => {
    const fetchImpl = vi.fn();
    const session = new McpSession();
    await expect(
      session.connectRemote({
        url: "https://metadata.example.test/mcp",
        fallbackToSse: false,
        network: {
          fetch: fetchImpl,
          resolveHostname: async () => [{ address: "169.254.169.254", family: 4 }],
        },
      }),
    ).rejects.toThrow("private address");
    expect(fetchImpl).not.toHaveBeenCalled();
    await session.close();
  });

  it("restarts a tool call's timeout on progress and keeps the session after a timeout", async () => {
    // A minimal stdio server: "slow" reports progress past the timeout before answering,
    // "silent" never answers, "echo" answers at once.
    const server = `
      const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
      let buffer = "";
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf("\\n")) >= 0) {
          const message = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          if (message.method === "initialize")
            send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } } });
          if (message.method !== "tools/call") continue;
          const answer = () => send({ id: message.id, result: { content: [{ type: "text", text: message.params.name }] } });
          if (message.params.name === "echo") answer();
          if (message.params.name !== "slow") continue;
          const progressToken = message.params._meta?.progressToken;
          let step = 0;
          const timer = setInterval(() => {
            step += 1;
            if (progressToken !== undefined)
              send({ method: "notifications/progress", params: { progressToken, progress: step } });
            if (step === 15) { clearInterval(timer); answer(); }
          }, 100);
        }
      });
    `;
    const session = new McpSession();
    await session.connectStdio({
      command: process.execPath,
      args: ["-e", server],
      allowedCommands: [process.execPath],
    });
    try {
      // Answers after 1.5 s, past the 1 s timeout, with progress every 100 ms keeping it alive.
      await expect(session.callTool("slow", {}, { timeoutMs: 1_000 })).resolves.toMatchObject({
        content: [{ type: "text", text: "slow" }],
      });
      await expect(session.callTool("silent", {}, { timeoutMs: 200 })).rejects.toMatchObject({
        code: -32001,
      });
      expect(session.open).toBe(true);
      await expect(session.callTool("echo")).resolves.toMatchObject({
        content: [{ type: "text", text: "echo" }],
      });
    } finally {
      await session.close();
    }
    expect(session.open).toBe(false);
  });

  it("requires a connected session for operations", async () => {
    const session = new McpSession();
    await expect(session.listTools()).rejects.toThrow("not connected");
    await expect(session.callTool("echo")).rejects.toThrow("not connected");
  });

  it.each([
    [
      "follows every cursor",
      3,
      2,
      ["page0-tool0", "page0-tool1", "page1-tool0", "page1-tool1", "page2-tool0", "page2-tool1"],
      3,
    ],
    ["stops at the tool cap", 3, 100, 250, 3],
    ["stops at the page cap of a server that never ends", Number.POSITIVE_INFINITY, 1, 20, 20],
  ] as const)(
    "lists paginated tools: %s",
    async (_name, pages, perPage, expected, requestedPages) => {
      const cursors: Array<string | undefined> = [];
      const session = new McpSession();
      try {
        await session.connectRemote({
          url: "https://mcp.example.test/mcp",
          network: {
            ...TEST_NETWORK,
            fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
              const request = new Request(input, init);
              if (request.method !== "POST") return new Response(null, { status: 405 });
              const message = await request.json();
              if (message.method === "initialize") {
                return Response.json({
                  jsonrpc: "2.0",
                  id: message.id,
                  result: {
                    protocolVersion: "2025-11-25",
                    capabilities: { tools: {} },
                    serverInfo: { name: "paginated", version: "1" },
                  },
                });
              }
              if (message.method !== "tools/list") return new Response(null, { status: 202 });
              const cursor: string | undefined = message.params?.cursor;
              cursors.push(cursor);
              const page = cursor ? Number(cursor.replace("page-", "")) : 0;
              return Response.json({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  tools: Array.from({ length: perPage }, (_, index) => ({
                    name: `page${page}-tool${index}`,
                    inputSchema: { type: "object" },
                  })),
                  ...(page + 1 < pages ? { nextCursor: `page-${page + 1}` } : {}),
                },
              });
            }),
          },
        });

        const names = (await session.listTools()).tools.map((tool) => tool.name);

        if (typeof expected === "number") expect(names).toHaveLength(expected);
        else expect(names).toEqual(expected);
        expect(cursors).toHaveLength(requestedPages);
        expect(cursors[0]).toBeUndefined();
        expect(cursors[1]).toBe("page-1");
      } finally {
        await session.close();
      }
    },
  );

  it("preserves SDK session and protocol headers after stateful initialization", async () => {
    const requests: Request[] = [];
    const session = new McpSession();
    try {
      await session.connectRemote({
        url: "https://mcp.example.test/mcp",
        network: {
          ...TEST_NETWORK,
          fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const request = new Request(input, init);
            requests.push(request);
            const message = request.method === "POST" ? await request.json() : undefined;
            if (message?.method === "initialize") {
              return Response.json(
                {
                  jsonrpc: "2.0",
                  id: message.id,
                  result: {
                    protocolVersion: "2025-11-25",
                    capabilities: { tools: {} },
                    serverInfo: { name: "fake-stateful-server", version: "1" },
                  },
                },
                { headers: { "Mcp-Session-Id": "fake-session" } },
              );
            }
            if (
              request.headers.get("mcp-session-id") !== "fake-session" ||
              request.headers.get("mcp-protocol-version") !== "2025-11-25"
            ) {
              return new Response(null, { status: 400 });
            }
            if (request.method === "GET") return new Response(null, { status: 405 });
            if (message?.method === "tools/list") {
              return Response.json({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
            }
            return new Response(null, { status: 202 });
          }),
        },
      });

      await expect(session.listTools()).resolves.toEqual({ tools: [] });
      expect(requests[0]?.headers.has("mcp-session-id")).toBe(false);
      expect(requests.length).toBeGreaterThanOrEqual(3);
      expect(
        requests
          .slice(1)
          .every((request) => request.headers.get("mcp-session-id") === "fake-session"),
      ).toBe(true);
    } finally {
      await session.close();
    }
  });

  it.each([
    ["https://mcp.example.test/mcp", "http://localhost:8123"],
    ["https://mcp.example.test/mcp", "http://127.0.0.1:8123"],
    ["https://mcp.example.test/mcp", "http://[::1]:8123"],
    ["https://localhost:8123/mcp", "http://localhost:8123"],
    ["http://localhost:8123/mcp", "http://localhost:8124"],
    ["http://localhost:8123/mcp", "http://127.0.0.1:8123"],
    ["http://[::1]:8123/mcp", "http://[::1]:8124"],
  ])("does not extend the local exception from %s to %s", async (resource, origin) => {
    const fetchImpl = vi.fn();
    const safeFetch = secureFetch(
      new URL(resource),
      { allowHttpLocalhost: true, allowLocalHttpCredentials: true },
      {},
      { ...TEST_NETWORK, fetch: fetchImpl },
    );
    try {
      await expect(safeFetch(`${origin}/.well-known/oauth-protected-resource`)).rejects.toThrow(
        "HTTPS",
      );
      await expect(
        safeFetch(`${origin}/token`, { method: "POST", body: "fake-token-body" }),
      ).rejects.toThrow("HTTPS");
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await safeFetch.close();
    }
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])(
    "allows explicitly configured HTTP %s discovery and token traffic on the same origin",
    async (host) => {
      const origin = `http://${host}:8123`;
      const fetchImpl = vi.fn(async () => Response.json({ ok: true }));
      const resolveHostname = vi.fn();
      const safeFetch = secureFetch(
        new URL(`${origin}/mcp`),
        { allowHttpLocalhost: true, allowPrivateEndpoint: true },
        {},
        { fetch: fetchImpl, resolveHostname },
      );
      try {
        await expect(
          safeFetch(`${origin}/.well-known/oauth-protected-resource`),
        ).resolves.toHaveProperty("ok", true);
        await expect(
          safeFetch(`${origin}/token`, { method: "POST", body: "fake-token-body" }),
        ).resolves.toHaveProperty("ok", true);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(resolveHostname).not.toHaveBeenCalled();
      } finally {
        await safeFetch.close();
      }
    },
  );

  it("releases the body of a refused local redirect", async () => {
    let cancels = 0;
    const body = new ReadableStream({
      cancel() {
        cancels += 1;
      },
    });
    const fetchImpl = vi.fn(
      async () => new Response(body, { status: 302, headers: { location: "http://10.9.9.9/" } }),
    );
    const safeFetch = secureFetch(
      new URL("http://localhost:8123/mcp"),
      { allowHttpLocalhost: true, allowPrivateEndpoint: true },
      {},
      { fetch: fetchImpl, resolveHostname: vi.fn() },
    );
    try {
      await expect(safeFetch("http://localhost:8123/mcp")).rejects.toThrow(
        "MCP redirects are not permitted",
      );
      expect(cancels).toBe(1);
    } finally {
      await safeFetch.close();
    }
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])(
    "refuses HTTP %s without the private-endpoint escape even when the hostname is local",
    async (host) => {
      const origin = `http://${host}:3100`;
      const fetchImpl = vi.fn(async () => Response.json({ ok: true }));
      const safeFetch = secureFetch(
        new URL(`${origin}/api/auth/get-session`),
        { allowHttpLocalhost: true, allowLocalHttpCredentials: true },
        {},
        { fetch: fetchImpl, resolveHostname: vi.fn() },
      );
      try {
        await expect(
          safeFetch(`${origin}/api/auth/get-session`, { method: "POST", body: "{}" }),
        ).rejects.toThrow("HTTPS");
        expect(fetchImpl).not.toHaveBeenCalled();
      } finally {
        await safeFetch.close();
      }
    },
  );

  it.each(["https://localhost:8123", "https://127.0.0.1:8123", "https://private.example.test"])(
    "applies remote network policy to discovery and token traffic at %s",
    async (origin) => {
      const fetchImpl = vi.fn();
      const safeFetch = secureFetch(
        new URL("http://localhost:8123/mcp"),
        { allowHttpLocalhost: true },
        {},
        {
          fetch: fetchImpl,
          resolveHostname: async () => [{ address: "10.0.0.1", family: 4 }],
        },
      );
      try {
        await expect(safeFetch(`${origin}/.well-known/oauth-protected-resource`)).rejects.toThrow(
          "private",
        );
        await expect(
          safeFetch(`${origin}/token`, { method: "POST", body: "fake-token-body" }),
        ).rejects.toThrow("private");
        expect(fetchImpl).not.toHaveBeenCalled();
      } finally {
        await safeFetch.close();
      }
    },
  );

  it("keeps SDK protocol headers on the resource origin and strips them on other origins", async () => {
    const safeFetch = secureFetch(
      new URL("https://mcp.example.test/mcp"),
      {},
      {},
      {
        ...TEST_NETWORK,
        fetch: vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
          Response.json(Object.fromEntries(new Headers(init?.headers))),
        ),
      },
    );
    const headers = {
      "mcp-session-id": "fake-session",
      "mcp-protocol-version": "2025-11-25",
      "last-event-id": "fake-event",
    };
    try {
      await expect(
        (await safeFetch("https://mcp.example.test/mcp", { headers })).json(),
      ).resolves.toEqual({ ...headers, host: "mcp.example.test" });
      await expect(
        (await safeFetch("https://auth.example.test/discovery", { headers })).json(),
      ).resolves.toEqual({ host: "auth.example.test" });
      await expect(
        (await safeFetch("https://mcp.example.test:8443/discovery", { headers })).json(),
      ).resolves.toEqual({ host: "mcp.example.test:8443" });
    } finally {
      await safeFetch.close();
    }
  });

  it("lets the SDK refresh a rejected token, persist rotation, and retry the MCP request", async () => {
    const resourceHeaders: string[] = [];
    const persisted: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(logicalHref(input, init));
        if (url.href === "https://auth.example.test/token") {
          return Response.json({
            access_token: "fresh-access",
            refresh_token: "rotated-refresh",
            token_type: "bearer",
            expires_in: 3600,
          });
        }
        if (url.href === "https://mcp.example.test/mcp") {
          const authorization = request.headers.get("authorization") ?? "";
          resourceHeaders.push(authorization);
          if (authorization === "Bearer stale-access") {
            return new Response(null, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
          }
          const message = JSON.parse(await request.text()) as { id?: number; method?: string };
          if (message.method === "initialize") {
            return Response.json({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: "2025-11-25",
                capabilities: {},
                serverInfo: { name: "test", version: "1" },
              },
            });
          }
          return new Response(null, { status: 202 });
        }
        throw new Error(`Unexpected request: ${request.method} ${url}`);
      }),
    );
    const provider = new StoredMcpOAuthProvider(
      "server-1",
      {
        oauth: {
          redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
          tokens: { access_token: "stale-access", refresh_token: "refresh", token_type: "bearer" },
          clientInformation: { client_id: "client-1" },
          discoveryState: {
            authorizationServerUrl: "https://auth.example.test",
            resourceMetadata: {
              resource: "https://mcp.example.test/mcp",
              authorization_servers: ["https://auth.example.test"],
            },
            authorizationServerMetadata: {
              issuer: "https://auth.example.test",
              authorization_endpoint: "https://auth.example.test/authorize",
              token_endpoint: "https://auth.example.test/token",
              response_types_supported: ["code"],
              grant_types_supported: ["authorization_code", "refresh_token"],
            },
          },
        },
      },
      async (material) => {
        persisted.push(structuredClone(material));
      },
    );
    const session = new McpSession();

    await session.connectRemote({
      url: "https://mcp.example.test/mcp",
      authProvider: provider,
      fallbackToSse: false,
      network: TEST_NETWORK,
    });

    expect(resourceHeaders[0]).toBe("Bearer stale-access");
    expect(resourceHeaders.slice(1)).not.toHaveLength(0);
    expect(resourceHeaders.slice(1).every((value) => value === "Bearer fresh-access")).toBe(true);
    expect(await provider.tokens()).toMatchObject({
      access_token: "fresh-access",
      refresh_token: "rotated-refresh",
    });
    // The SDK records the issuer on the stored client first, then the rotation lands once.
    expect(persisted).toMatchObject([
      { oauth: { clientInformation: { issuer: "https://auth.example.test" } } },
      {
        oauth: {
          tokens: { refresh_token: "rotated-refresh", issuer: "https://auth.example.test" },
        },
      },
    ]);
    await session.close();
  });

  it("invalidates a dead refresh token and surfaces reconnect instead of silently losing tools", async () => {
    const persisted: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = logicalHref(input, init);
        if (url === "https://auth.example.test/token") {
          return Response.json(
            { error: "invalid_grant", error_description: "refresh token revoked" },
            { status: 400 },
          );
        }
        if (url === "https://mcp.example.test/mcp") {
          return new Response(null, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
        }
        throw new Error(`Unexpected request: ${request.method} ${url}`);
      }),
    );
    const provider = new StoredMcpOAuthProvider(
      "server-1",
      {
        oauth: {
          redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
          tokens: {
            access_token: "stale-access",
            refresh_token: "dead-refresh",
            token_type: "bearer",
          },
          clientInformation: { client_id: "client-1" },
          discoveryState: {
            authorizationServerUrl: "https://auth.example.test",
            resourceMetadata: {
              resource: "https://mcp.example.test/mcp",
              authorization_servers: ["https://auth.example.test"],
            },
            authorizationServerMetadata: {
              issuer: "https://auth.example.test",
              authorization_endpoint: "https://auth.example.test/authorize",
              token_endpoint: "https://auth.example.test/token",
              response_types_supported: ["code"],
              grant_types_supported: ["authorization_code", "refresh_token"],
            },
          },
        },
      },
      async (material) => {
        persisted.push(structuredClone(material));
      },
    );
    const session = new McpSession();

    await expect(
      session.connectRemote({
        url: "https://mcp.example.test/mcp",
        authProvider: provider,
        fallbackToSse: false,
        network: TEST_NETWORK,
      }),
    ).rejects.toThrow("Reconnect this server");

    expect(await provider.tokens()).toBeUndefined();
    expect(persisted.length).toBeGreaterThanOrEqual(1);
  });

  // Real HTTP on purpose: undici drops the whole request ("fetch failed",
  // cause "expected non-null body source") when a stream-bodied POST meets a
  // server that answers 401 without draining the body — the exact shape of an
  // OAuth challenge. A stubbed fetch can never catch this.
  it("receives the OAuth 401 challenge from a server that rejects before reading the request body", async () => {
    const server = createServer((req, res) => {
      if (req.method !== "POST" || !req.url?.startsWith("/mcp")) {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.statusCode = 401;
      res.setHeader("WWW-Authenticate", "Bearer");
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const provider = new StoredMcpOAuthProvider(
      "server-1",
      {
        oauth: {
          redirectUri: "http://127.0.0.1:5173/mcp/oauth/callback",
          clientInformation: { client_id: "client-1" },
          discoveryState: {
            authorizationServerUrl: `http://127.0.0.1:${port}`,
            authorizationServerMetadata: {
              issuer: `http://127.0.0.1:${port}`,
              authorization_endpoint: `http://127.0.0.1:${port}/authorize`,
              token_endpoint: `http://127.0.0.1:${port}/token`,
              response_types_supported: ["code"],
            },
          },
        },
      },
      async () => {},
    );
    const session = new McpSession();
    try {
      await expect(
        session.connectRemote({
          url: `http://127.0.0.1:${port}/mcp`,
          authProvider: provider,
          fallbackToSse: false,
          urlPolicy: { allowHttpLocalhost: true, allowPrivateEndpoint: true },
        }),
      ).rejects.toThrow("Reconnect this server");
    } finally {
      await session.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("strips sensitive headers when falling back to the endpoint origin", async () => {
    const seen: Record<string, string>[] = [];
    const inner = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url === "https://private.example.test/data") throw new TypeError("fetch failed");
      seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
      return Response.json({ ok: true });
    });
    const fallback = withEndpointOriginFallback(
      "https://endpoint.example.test",
      inner as typeof fetch,
    );

    const response = await fallback("https://private.example.test/data", {
      headers: { authorization: "Bearer secret", "x-custom": "keep-me" },
    });

    expect(response.ok).toBe(true);
    const retry = seen[0] ?? {};
    expect(retry.authorization).toBeUndefined();
    expect(retry.cookie).toBeUndefined();
    expect(retry["x-custom"]).toBe("keep-me");
  });

  it("keeps sensitive headers on same-origin and first-attempt requests", async () => {
    const inner = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return Response.json({ authorization: request.headers.get("authorization") });
    });
    const fallback = withEndpointOriginFallback(
      "https://endpoint.example.test",
      inner as typeof fetch,
    );

    const direct = await fallback("https://endpoint.example.test/api", {
      headers: { authorization: "Bearer secret" },
    });
    await expect(direct.json()).resolves.toEqual({ authorization: "Bearer secret" });
  });

  it.each(["X-Api-Key", "X_API_KEY"])(
    "strips configured %s from localhost HTTP requests",
    async (headerName) => {
      let seen: Record<string, string> = {};
      const safeFetch = secureFetch(
        new URL("http://localhost:8123/mcp"),
        { allowHttpLocalhost: true, allowPrivateEndpoint: true },
        {
          allowedHeaders: ["authorization", headerName],
          headers: { Authorization: "Bearer stored", [headerName]: "stored-key" },
        },
        {
          fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const request = input instanceof Request ? input : new Request(input, init);
            seen = Object.fromEntries(request.headers.entries());
            return Response.json({ ok: true });
          }),
        },
      );

      await safeFetch("http://localhost:8123/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer sdk",
          [headerName]: "sdk-key",
          "Content-Type": "application/json",
        },
        body: "{}",
      });

      expect(seen.authorization).toBeUndefined();
      expect(seen[headerName.toLowerCase()]).toBeUndefined();
      expect(seen["content-type"]).toBe("application/json");
    },
  );

  it.each(["X-Api-Key", "X_API_KEY"])(
    "keeps configured %s for HTTPS requests",
    async (headerName) => {
      let seen: Record<string, string> = {};
      const safeFetch = secureFetch(
        new URL("https://mcp.example.test/mcp"),
        {},
        {
          allowedHeaders: ["authorization", headerName],
          headers: { Authorization: "Bearer stored", [headerName]: "stored-key" },
        },
        {
          resolveHostname: TEST_NETWORK.resolveHostname,
          fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const request = input instanceof Request ? input : new Request(input, init);
            seen = Object.fromEntries(request.headers.entries());
            return Response.json({ ok: true });
          }),
        },
      );

      await safeFetch("https://mcp.example.test/mcp", { method: "POST", body: "{}" });

      expect(seen.authorization).toBe("Bearer stored");
      expect(seen[headerName.toLowerCase()]).toBe("stored-key");
    },
  );

  it("drops request headers outside the configured allowlist", async () => {
    let seen: Record<string, string> = {};
    const safeFetch = secureFetch(
      new URL("https://mcp.example.test/mcp"),
      {},
      { allowedHeaders: ["accept"] },
      {
        resolveHostname: TEST_NETWORK.resolveHostname,
        fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          seen = Object.fromEntries(request.headers.entries());
          return Response.json({ ok: true });
        }),
      },
    );

    await safeFetch("https://mcp.example.test/mcp", {
      headers: { Accept: "application/json", "X-Untrusted": "drop-me" },
    });

    expect(seen.accept).toBe("application/json");
    expect(seen["x-untrusted"]).toBeUndefined();
  });

  it("honours init header replacement for Request inputs", async () => {
    let seen: Record<string, string> = {};
    const safeFetch = secureFetch(
      new URL("https://mcp.example.test/mcp"),
      {},
      {},
      {
        resolveHostname: TEST_NETWORK.resolveHostname,
        fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          seen = Object.fromEntries(request.headers.entries());
          return Response.json({ ok: true });
        }),
      },
    );
    const request = new Request("https://mcp.example.test/mcp", {
      headers: { Authorization: "Bearer stale", "Content-Type": "application/json" },
    });

    await safeFetch(request, { headers: { Accept: "application/json" } });

    expect(seen.accept).toBe("application/json");
    expect(seen.authorization).toBeUndefined();
    expect(seen["content-type"]).toBeUndefined();
  });

  it.each(["X-Api-Key", "X_API_KEY"])(
    "does not forward configured %s to another origin",
    async (headerName) => {
      let seen: Record<string, string> = {};
      const safeFetch = secureFetch(
        new URL("https://mcp.example.test/mcp"),
        {},
        { headers: { Authorization: "Bearer stored", [headerName]: "stored-key" } },
        {
          resolveHostname: TEST_NETWORK.resolveHostname,
          fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const request = input instanceof Request ? input : new Request(input, init);
            seen = Object.fromEntries(request.headers.entries());
            return Response.json({ ok: true });
          }),
        },
      );

      await safeFetch("https://auth.example.test/token", {
        headers: { Authorization: "Bearer stored", [headerName]: "stored-key" },
      });

      expect(seen.authorization).toBeUndefined();
      expect(seen[headerName.toLowerCase()]).toBeUndefined();
    },
  );

  it("does not forward configured credential values under another header name", async () => {
    let seen: Record<string, string> = {};
    const safeFetch = secureFetch(
      new URL("https://mcp.example.test/mcp"),
      {},
      { headers: { "X-Api-Key": "stored-key" } },
      {
        resolveHostname: TEST_NETWORK.resolveHostname,
        fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          seen = Object.fromEntries(request.headers.entries());
          return Response.json({ ok: true });
        }),
      },
    );

    await safeFetch("https://auth.example.test/token", {
      headers: { Authorization: "stored-key" },
    });

    expect(seen.authorization).toBeUndefined();
  });

  it("never retries a failed write against the endpoint origin", async () => {
    const inner = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const fallback = withEndpointOriginFallback(
      "https://endpoint.example.test",
      inner as typeof fetch,
    );

    await expect(
      fallback("https://private.example.test/register", {
        method: "POST",
        body: "client_secret=secret",
      }),
    ).rejects.toThrow("fetch failed");
    expect(inner).toHaveBeenCalledTimes(1);
  });
});
