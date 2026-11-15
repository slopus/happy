import { createServer } from "node:http";
import { fetch as undiciFetch } from "undici";
import { describe, expect, it, vi } from "vitest";
import {
  classifySerenityEndpointTrust,
  createSerenityPrivateLanFetch,
  forgetSerenity,
  MAX_SERENITY_FACT_BYTES,
  normalizeSerenityEndpoint,
  parseSerenityEndpoint,
  probeSerenity,
  recallSerenity,
  rememberSerenity,
  serenityEndpointRequiresPrivateEndpoint,
} from "./serenity-client.js";

const TOKEN = "serenity_test_token";

describe("serenity endpoint helpers", () => {
  it("requires an explicit endpoint and does not assume a hosted URL", async () => {
    expect(() => parseSerenityEndpoint("")).toThrow("Serenity endpoint is required.");
    expect(() => parseSerenityEndpoint("   ")).toThrow("Serenity endpoint is required.");
    expect(() => normalizeSerenityEndpoint("")).toThrow("Serenity endpoint is required.");
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const resolveHostname = vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]);
    const result = await probeSerenity({ endpoint: "", token: TOKEN }, undefined, {
      fetch: fetchMock,
      resolveHostname,
    });
    expect(result).toEqual({
      ok: false,
      error: "Serenity is unreachable: Serenity endpoint is required.",
    });
    expect(resolveHostname).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("appends /mcp when missing", () => {
    expect(normalizeSerenityEndpoint("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787/mcp");
    expect(normalizeSerenityEndpoint("https://serenity.example.test/mcp")).toBe(
      "https://serenity.example.test/mcp",
    );
  });

  it("rejects credentials, queries, and fragments", () => {
    expect(() => parseSerenityEndpoint("https://user:pass@serenity.example.test/mcp")).toThrow(
      /credentials/,
    );
    expect(() => parseSerenityEndpoint("https://serenity.example.test/mcp?x=1")).toThrow(/query/);
    expect(() => parseSerenityEndpoint("https://serenity.example.test/mcp#frag")).toThrow(
      /fragment/,
    );
  });

  it("requires deployment-owner trust for loopback, private LAN, and private DNS", () => {
    expect(serenityEndpointRequiresPrivateEndpoint("http://127.0.0.1:8787/mcp")).toBe(true);
    expect(serenityEndpointRequiresPrivateEndpoint("http://192.168.1.10:8787/mcp")).toBe(true);
    expect(serenityEndpointRequiresPrivateEndpoint("https://192.168.1.10:8787/mcp")).toBe(true);
    expect(serenityEndpointRequiresPrivateEndpoint("https://serenity.internal/mcp")).toBe(true);
    expect(serenityEndpointRequiresPrivateEndpoint("https://serenity.example.test/mcp")).toBe(
      false,
    );
  });

  it("rejects public HTTP endpoints and private-LAN cleartext HTTP", () => {
    expect(() => normalizeSerenityEndpoint("http://serenity.example.test/mcp")).toThrow(/loopback/);
    expect(() => normalizeSerenityEndpoint("http://192.168.1.10:8787/mcp")).toThrow(/loopback/);
  });
});

describe("serenity SSRF fetch path", () => {
  it("rejects public HTTPS when DNS returns a private address", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const result = await probeSerenity(
      { endpoint: "https://serenity.example.test/mcp", token: TOKEN },
      undefined,
      {
        fetch: fetchMock,
        resolveHostname: async () => [{ address: "10.1.2.3", family: 4 as const }],
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/private address/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows public HTTPS when DNS returns a public address (safe fetch runs)", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("safe-path-fetch-reached");
    });
    let resolved = false;
    const result = await probeSerenity(
      { endpoint: "https://serenity.example.test/mcp", token: TOKEN },
      undefined,
      {
        fetch: fetchMock,
        resolveHostname: async () => {
          resolved = true;
          return [{ address: "203.0.113.10", family: 4 as const }];
        },
      },
    );
    expect(resolved).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/safe-path-fetch-reached|Could not reach/);
  });

  it("uses plain fetch for loopback without DNS pinning", async () => {
    let resolved = false;
    const fetchMock = vi.fn(async () => {
      throw new Error("plain-fetch-reached");
    });
    const result = await probeSerenity(
      { endpoint: "http://127.0.0.1:8787/mcp", token: TOKEN },
      undefined,
      {
        fetch: fetchMock,
        resolveHostname: async () => {
          resolved = true;
          return [{ address: "10.1.2.3", family: 4 as const }];
        },
      },
    );
    expect(resolved).toBe(false);
    expect(fetchMock).toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/plain-fetch-reached/);
  });

  it("releases the body of a refused loopback redirect", async () => {
    let cancels = 0;
    const body = new ReadableStream({
      cancel() {
        cancels += 1;
      },
    });
    const fetchMock = vi.fn(
      async () => new Response(body, { status: 302, headers: { location: "http://10.9.9.9/" } }),
    );
    const result = await probeSerenity(
      { endpoint: "http://127.0.0.1:8787/mcp", token: TOKEN },
      undefined,
      { fetch: fetchMock },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/redirects are not permitted/);
    expect(cancels).toBe(1);
  });

  it("rejects public-looking HTTPS when DNS is private unless prepare marked trust", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const result = await probeSerenity(
      { endpoint: "https://serenity.example.test/mcp", token: TOKEN },
      undefined,
      {
        fetch: fetchMock,
        resolveHostname: async () => [{ address: "10.8.0.2", family: 4 as const }],
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/private address/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pins private-trust HTTPS hostnames and rejects metadata rebinding", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const result = await probeSerenity(
      {
        endpoint: "https://serenity.example.test/mcp",
        token: TOKEN,
        endpointTrust: "private",
      },
      undefined,
      {
        fetch: fetchMock,
        resolveHostname: async () => [{ address: "169.254.169.254", family: 4 as const }],
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/blocked address/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pins private-trust HTTPS to the first DNS answer within a request", async () => {
    let resolveCalls = 0;
    const fetchMock = vi.fn(async () => {
      throw new Error("pinned-first-answer-fetch-reached");
    });
    const result = await probeSerenity(
      {
        endpoint: "https://serenity.example.test/mcp",
        token: TOKEN,
        endpointTrust: "private",
      },
      undefined,
      {
        fetch: fetchMock,
        resolveHostname: async () => {
          resolveCalls += 1;
          if (resolveCalls === 1) {
            return [{ address: "10.8.0.2", family: 4 as const }];
          }
          return [{ address: "10.9.9.9", family: 4 as const }];
        },
      },
    );
    expect(resolveCalls).toBe(1);
    expect(fetchMock).toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toMatch(/pinned-first-answer-fetch-reached|Could not reach/);
  });

  it("pins private-trust HTTPS hostnames and rejects public rebinding", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const result = await probeSerenity(
      {
        endpoint: "https://serenity.example.test/mcp",
        token: TOKEN,
        endpointTrust: "private",
      },
      undefined,
      {
        fetch: fetchMock,
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 as const }],
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no longer resolves to a private address/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pins private-trust HTTPS hostnames to private LAN answers", async () => {
    let resolved = false;
    const fetchMock = vi.fn(async () => {
      throw new Error("private-resolving-dns-fetch-reached");
    });
    const result = await probeSerenity(
      {
        endpoint: "https://serenity.example.test/mcp",
        token: TOKEN,
        endpointTrust: "private",
      },
      undefined,
      {
        fetch: fetchMock,
        resolveHostname: async () => {
          resolved = true;
          return [{ address: "10.8.0.2", family: 4 as const }];
        },
      },
    );
    expect(resolved).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toMatch(/private-resolving-dns-fetch-reached|Could not reach/);
  });

  it("classifies private-resolving HTTPS hostnames as private trust", async () => {
    await expect(
      classifySerenityEndpointTrust("https://serenity.example.test/mcp", async () => [
        { address: "10.8.0.2", family: 4 as const },
      ]),
    ).resolves.toBe("private");
    await expect(
      classifySerenityEndpointTrust("https://serenity.example.test/mcp", async () => [
        { address: "203.0.113.10", family: 4 as const },
      ]),
    ).resolves.toBe("public");
  });
  it("pins private DNS HTTPS and allows private LAN answers", async () => {
    let resolved = false;
    const fetchMock = vi.fn(async () => {
      throw new Error("private-dns-fetch-reached");
    });
    const result = await probeSerenity(
      { endpoint: "https://serenity.internal/mcp", token: TOKEN },
      undefined,
      {
        fetch: fetchMock,
        resolveHostname: async () => {
          resolved = true;
          return [{ address: "10.1.2.3", family: 4 as const }];
        },
      },
    );
    expect(resolved).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/private-dns-fetch-reached|Could not reach/);
  });

  it("uses plain fetch for private LAN HTTPS without assertPublicAddresses", async () => {
    let resolved = false;
    const fetchMock = vi.fn(async () => {
      throw new Error("private-lan-fetch-reached");
    });
    const result = await probeSerenity(
      { endpoint: "https://192.168.1.10:8787/mcp", token: TOKEN },
      undefined,
      {
        fetch: fetchMock,
        resolveHostname: async () => {
          resolved = true;
          return [{ address: "203.0.113.10", family: 4 as const }];
        },
      },
    );
    expect(resolved).toBe(false);
    expect(fetchMock).toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/private-lan-fetch-reached/);
  });

  it("drives the private-hostname dispatcher with a fetch from the same undici", async () => {
    // A mismatched fetch throws invalid onRequestStart before the socket opens, so a completed
    // response proves the package fetch accepted the Agent.
    expect(undiciFetch).not.toBe(globalThis.fetch);
    let hits = 0;
    const server = createServer((request, response) => {
      // A local tool can probe any listening loopback port; only Serenity calls are counted.
      if (request.method !== "GET" || request.url !== "/mcp") {
        request.resume();
        response.writeHead(404).end();
        return;
      }
      hits += 1;
      response.writeHead(204);
      response.end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address == null || typeof address === "string") {
      throw new Error("Missing test server address");
    }
    const captured = globalThis.fetch;
    try {
      for (const injected of [undefined, globalThis.fetch, captured] as const) {
        const safeFetch = createSerenityPrivateLanFetch(injected, async () => [
          { address: "127.0.0.1", family: 4 as const },
        ]);
        try {
          const response = await safeFetch(`http://serenity.example.test:${address.port}/mcp`, {
            signal: AbortSignal.timeout(2_000),
          });
          expect(response.status).toBe(204);
        } finally {
          await safeFetch.close();
        }
      }
      expect(hits).toBe(3);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("releases a large private-hostname rate-limit response before closing its dispatcher", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(429, { "retry-after": "30" });
      response.end("x".repeat(1_000_000));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address == null || typeof address === "string") {
      throw new Error("Missing test server address");
    }
    const safeFetch = createSerenityPrivateLanFetch(undefined, async () => [
      { address: "127.0.0.1", family: 4 as const },
    ]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        safeFetch(`http://serenity.example.test:${address.port}/mcp`).then(
          (response) => response.status,
        ),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve("still waiting"), 2_000);
        }),
      ]);
      expect(outcome).toBe(429);
    } finally {
      clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("refuses a private-hostname redirect without waiting on its body", async () => {
    // Larger than undici buffers, so an unread body holds the per-request Agent open.
    const server = createServer((_request, response) => {
      response.writeHead(302, { location: "http://serenity.example.test/elsewhere" });
      response.end("x".repeat(1_000_000));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address == null || typeof address === "string") {
      throw new Error("Missing test server address");
    }
    const safeFetch = createSerenityPrivateLanFetch(undefined, async () => [
      { address: "127.0.0.1", family: 4 as const },
    ]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        safeFetch(`http://serenity.example.test:${address.port}/mcp`).then(
          () => "returned",
          (error: unknown) => String(error),
        ),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve("still waiting"), 2_000);
        }),
      ]);
      expect(outcome).toMatch(/redirects are not permitted/);
    } finally {
      clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

/** One entry of `facts` in Serenity's recall response (internal/server/memory/recall.go). */
type SerenityRecallFactRow = {
  id: number;
  fact_id: string;
  fact: string;
  kind: string;
  entity_slug: string | null;
  provenance: string;
  valid_until: string | null;
  visibility: string;
};

type JsonRpcRequest = { id?: number; method: string; params?: { arguments?: unknown } };

/** Minimal Streamable HTTP MCP server over the fetch seam; `toolResult` answers tools/call. */
function fakeSerenityFetch(toolResult: (args: unknown) => unknown) {
  const calls: { method: string; rpc?: JsonRpcRequest }[] = [];
  const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method !== "POST") {
      calls.push({ method });
      return new Response(null, { status: method === "DELETE" ? 200 : 405 });
    }
    const rpc = JSON.parse(String(init?.body)) as JsonRpcRequest;
    calls.push({ method, rpc });
    const headers = { "content-type": "application/json", "mcp-session-id": "session-1" };
    if (rpc.id === undefined) return new Response(null, { status: 202, headers });
    const result =
      rpc.method === "initialize"
        ? {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "serenity", version: "test" },
          }
        : toolResult(rpc.params?.arguments);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }), { headers });
  });
  return { fetch, calls };
}

const LOOPBACK = { endpoint: "http://127.0.0.1:8787/mcp", token: TOKEN };

describe("serenity verbs", () => {
  it("sends the operation key with remember and ends the MCP session", async () => {
    const server = fakeSerenityFetch(() => ({
      content: [{ type: "text", text: JSON.stringify({ id: "fact-1", status: "inserted" }) }],
    }));
    const result = await rememberSerenity("Use metric units.", "rakazo", LOOPBACK, {
      entity: "rakazo-bot/bot-1",
      operationKey: "rakazo:abc",
      network: { fetch: server.fetch },
    });
    expect(result).toEqual({ ok: true, value: { id: "fact-1", status: "inserted" } });
    const call = server.calls.find((entry) => entry.rpc?.method === "tools/call");
    expect(call?.rpc?.params?.arguments).toMatchObject({
      entity: "rakazo-bot/bot-1",
      operation_key: "rakazo:abc",
    });
    expect(server.calls.at(-1)?.method).toBe("DELETE");
  });

  it("asks recall for the most facts without the query, which only drives page search", async () => {
    const facts: SerenityRecallFactRow[] = Array.from({ length: 100 }, (_, index) => ({
      id: index,
      fact_id: `fact-${index}`,
      fact: `Fact ${index}`,
      kind: "preference",
      entity_slug: "bot-1",
      provenance: "rakazo",
      valid_until: null,
      visibility: "world",
    }));
    const server = fakeSerenityFetch(() => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({ protocol_version: 1, facts, total: facts.length }),
        },
      ],
    }));
    const result = await recallSerenity(LOOPBACK, {
      entity: "rakazo-bot/bot-1",
      network: { fetch: server.fetch },
    });
    expect(result.ok && result.value).toHaveLength(100);
    const call = server.calls.find((entry) => entry.rpc?.method === "tools/call");
    expect(call?.rpc?.params?.arguments).toEqual({ limit: 100, entity: "rakazo-bot/bot-1" });
  });

  it("rejects facts over the hosted byte limit before connecting", async () => {
    const server = fakeSerenityFetch(() => ({}));
    const result = await rememberSerenity(
      "é".repeat(MAX_SERENITY_FACT_BYTES / 2 + 1),
      "rakazo",
      LOOPBACK,
      { network: { fetch: server.fetch } },
    );
    expect(result).toEqual({
      ok: false,
      error: `fact exceeds ${MAX_SERENITY_FACT_BYTES} bytes; save a shorter fact`,
    });
    expect(server.fetch).not.toHaveBeenCalled();
  });

  it("states a tool error code once and keeps its reset time", async () => {
    const server = fakeSerenityFetch(() => ({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "limit_exceeded",
            message: "limit_exceeded",
            suggestion: "Upgrade your plan.",
            reset_at: "2026-10-01T00:00:00Z",
          }),
        },
      ],
    }));
    const result = await recallSerenity(LOOPBACK, { network: { fetch: server.fetch } });
    expect(result).toEqual({
      ok: false,
      error:
        "Serenity recall failed: limit_exceeded Upgrade your plan. Resets at 2026-10-01T00:00:00Z.",
    });
  });

  it("never surfaces its own token from server errors or results", async () => {
    const echoing = fakeSerenityFetch(() => ({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ message: `bad token ${TOKEN}; got Bearer ${TOKEN}` }),
        },
      ],
    }));
    const recalled = await recallSerenity(LOOPBACK, { network: { fetch: echoing.fetch } });
    expect(recalled.ok).toBe(false);
    expect(JSON.stringify(recalled)).not.toContain(TOKEN);

    const rejecting = vi.fn(
      async () => new Response(`unauthorized: Authorization: Bearer ${TOKEN}`, { status: 500 }),
    );
    const forgotten = await forgetSerenity("fact-1", LOOPBACK, { network: { fetch: rejecting } });
    expect(forgotten.ok).toBe(false);
    expect(JSON.stringify(forgotten)).not.toContain(TOKEN);

    const statusEcho = fakeSerenityFetch(() => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({ id: "fact-1", status: "inserted", status_text: `as ${TOKEN}` }),
        },
      ],
    }));
    const remembered = await rememberSerenity("Use metric units.", "rakazo", LOOPBACK, {
      network: { fetch: statusEcho.fetch },
    });
    expect(remembered.ok).toBe(true);
    expect(JSON.stringify(remembered)).not.toContain(TOKEN);
  });

  it.each([
    ["loopback", "http://127.0.0.1:8787/mcp", undefined, "127.0.0.1"],
    ["public DNS", "https://serenity.example.test/mcp", "public", "93.184.216.34"],
    ["private DNS", "https://serenity.internal/mcp", "private", "10.1.2.3"],
  ] as const)(
    "cancels a rate-limited response on %s",
    async (_name, endpoint, endpointTrust, address) => {
      let cancels = 0;
      const body = new ReadableStream({
        cancel() {
          cancels += 1;
        },
      });
      const fetch = vi.fn(
        async () => new Response(body, { status: 429, headers: { "retry-after": "30" } }),
      );
      const result = await probeSerenity({ endpoint, token: TOKEN, endpointTrust }, undefined, {
        fetch,
        resolveHostname: async () => [{ address, family: 4 as const }],
      });
      expect(result).toEqual({
        ok: false,
        error: "Serenity is unreachable: Serenity rate limit reached; retry after 30s.",
      });
      expect(cancels).toBe(1);
    },
  );

  it("reports gateway rate limits with the retry delay", async () => {
    const fetch = vi.fn(
      async () => new Response("slow down", { status: 429, headers: { "retry-after": "30" } }),
    );
    const result = await recallSerenity(LOOPBACK, { network: { fetch } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/rate limit reached; retry after 30s/);
  });

  it("keeps an HTTP-date Retry-After as a date", async () => {
    const date = "Wed, 23 Sep 2026 23:40:00 GMT";
    const fetch = vi.fn(
      async () => new Response("slow down", { status: 429, headers: { "retry-after": date } }),
    );
    const result = await recallSerenity(LOOPBACK, { network: { fetch } });
    if (!result.ok) expect(result.error).toContain(`retry after ${date}.`);
    expect(result.ok).toBe(false);
  });

  it("returns even when the server stalls the session DELETE", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const server = fakeSerenityFetch(() => ({
        content: [{ type: "text", text: JSON.stringify({ facts: [] }) }],
      }));
      const stalling = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
        init?.method === "DELETE" ? new Promise<Response>(() => {}) : server.fetch(input, init),
      );
      const pending = recallSerenity(LOOPBACK, { network: { fetch: stalling } });
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toEqual({ ok: true, value: [] });
    } finally {
      vi.useRealTimers();
    }
  });
});
