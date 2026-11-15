import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupermemorySaveResponse } from "./supermemory-client.js";
import {
  deleteSupermemoryContainer,
  MAX_MEMORY_CONTENT_CHARS,
  MAX_RECALLED_MEMORIES,
  MAX_SUPERMEMORY_RESPONSE_BYTES,
  probeSupermemory,
  SUPERMEMORY_DELETE_FORBIDDEN_ERROR,
  saveSupermemoryMemory,
  saveSupermemoryMemoryToContainers,
  searchSupermemory,
  searchSupermemoryContainers,
} from "./supermemory-client.js";

const config = { baseUrl: "http://localhost:6767", apiKey: "sm_test_key" };

afterEach(() => vi.unstubAllGlobals());

describe("Supermemory request URLs", () => {
  const operations = [
    { method: "GET", path: "/v3/container-tags/list", request: probeSupermemory },
    {
      method: "POST",
      path: "/v4/search",
      request: (connection: typeof config) => searchSupermemory("query", "fake:tag", connection),
    },
    {
      method: "POST",
      path: "/v4/memories",
      request: (connection: typeof config) => saveSupermemoryMemory("fact", "fake:tag", connection),
    },
    {
      method: "DELETE",
      path: "/v3/container-tags/fake%3Atag",
      request: (connection: typeof config) => deleteSupermemoryContainer("fake:tag", connection),
    },
  ];

  it.each([
    "http://127.0.0.1:8123/internal-action#",
    "http://127.0.0.1:8123/internal-action#ignored",
    "http://127.0.0.1:8123/internal-action?",
    "http://127.0.0.1:8123/internal-action?action=delete",
    "http://fake:credential@localhost:6767",
    "file:///fake-memory",
  ])("rejects ambiguous base URLs before every transport call: %s", async (baseUrl) => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ results: [] }));
    vi.stubGlobal("fetch", fetchMock);
    for (const { request } of operations) {
      expect(await request({ ...config, baseUrl })).toMatchObject({ ok: false });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["", "/", "/memory", "/memory/"])(
    "preserves the base prefix and provider route for every method: %s",
    async (prefix) => {
      const fetchMock = vi.fn().mockImplementation(async () => Response.json({ results: [] }));
      vi.stubGlobal("fetch", fetchMock);
      for (const { request, method, path } of operations) {
        expect(await request({ ...config, baseUrl: `http://[::1]:6767${prefix}` })).toMatchObject({
          ok: true,
        });
        const [url, init] = fetchMock.mock.lastCall!;
        expect(url).toBe(`http://[::1]:6767${prefix.replace(/\/$/, "")}${path}`);
        expect(init).toMatchObject({ method, redirect: "error" });
      }
    },
  );
});

describe("searchSupermemory", () => {
  it("posts the query and container tag, returning search results on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [{ memory: "User prefers British English", similarity: 0.9 }],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchSupermemory("spelling preference", "rakazo:bot-123", config);

    expect(result).toEqual({
      ok: true,
      results: [{ memory: "User prefers British English", similarity: 0.9 }],
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:6767/v4/search");
    expect(init.headers.Authorization).toBe("Bearer sm_test_key");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body)).toStrictEqual({
      q: "spelling preference",
      containerTag: "rakazo:bot-123",
      searchMode: "memories",
      limit: MAX_RECALLED_MEMORIES,
    });
    vi.unstubAllGlobals();
  });

  it("reports a non-OK response instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
    const result = await searchSupermemory("anything", "rakazo:bot-123", config);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("500") });
    vi.unstubAllGlobals();
  });

  it("reports an unreachable server instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));
    const result = await searchSupermemory("anything", "rakazo:bot-123", config);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("unreachable") });
    vi.unstubAllGlobals();
  });

  it("treats document chunks as memory text when the search result has no memory field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ results: [{ chunk: "Older decision: use Postgres." }] }), {
          status: 200,
        }),
      ),
    );

    const result = await searchSupermemory("database", "rakazo:bot-123", config);

    expect(result).toEqual({
      ok: true,
      results: [{ memory: "Older decision: use Postgres.", similarity: 0 }],
    });
    vi.unstubAllGlobals();
  });

  it("drops malformed search hits instead of injecting empty memories", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ results: [{}, { memory: "  " }, "nope", { memory: "kept" }] }),
          {
            status: 200,
          },
        ),
      ),
    );

    const result = await searchSupermemory("anything", "rakazo:bot-123", config);

    expect(result).toEqual({ ok: true, results: [{ memory: "kept", similarity: 0 }] });
    vi.unstubAllGlobals();
  });

  it("bounds each recalled memory to the provider content limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ results: [{ memory: `kept${"x".repeat(20_000)}` }] })),
        ),
    );

    const result = await searchSupermemory("anything", "rakazo:bot-123", config);

    expect(result.ok && result.results[0]?.memory).toHaveLength(MAX_MEMORY_CONTENT_CHARS);
    vi.unstubAllGlobals();
  });

  it("rejects an oversized search response before buffering it", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({
          "content-length": String(MAX_SUPERMEMORY_RESPONSE_BYTES + 1),
        }),
        body: { cancel },
      }),
    );

    const result = await searchSupermemory("anything", "rakazo:bot-123", config);

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("response is too large"),
    });
    expect(cancel).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("caps a chunked search response without a content length", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(new Uint8Array(MAX_SUPERMEMORY_RESPONSE_BYTES + 1))),
    );

    const result = await searchSupermemory("anything", "rakazo:bot-123", config);

    expect(result).toEqual({ ok: false, error: "Supermemory response is too large." });
    vi.unstubAllGlobals();
  });
});

describe("searchSupermemoryContainers", () => {
  it("deduplicates and ranks results from shared and bot containers", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ results: [{ memory: "shared", similarity: 0.7 }] }), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              results: [
                { memory: "private", similarity: 0.9 },
                { memory: "shared", similarity: 0.6 },
              ],
            }),
            { status: 200 },
          ),
        ),
    );

    await expect(
      searchSupermemoryContainers("query", ["rakazo:workspace:ws-1", "rakazo:bot-1"], config),
    ).resolves.toEqual({
      ok: true,
      results: [
        { memory: "private", similarity: 0.9 },
        { memory: "shared", similarity: 0.7 },
      ],
    });
    vi.unstubAllGlobals();
  });
});

describe("saveSupermemoryMemory", () => {
  it("posts the content and container tag on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await saveSupermemoryMemory(
      "User prefers British English",
      "rakazo:bot-123",
      config,
    );

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:6767/v4/memories");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body)).toEqual({
      containerTag: "rakazo:bot-123",
      memories: [{ content: "User prefers British English", isStatic: false }],
    });
    vi.unstubAllGlobals();
  });

  it("caps oversized content at the API limit", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await saveSupermemoryMemory(
      `prefix ${"x".repeat(MAX_MEMORY_CONTENT_CHARS)}`,
      "rakazo:bot-123",
      config,
    );

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.memories[0].content).toHaveLength(MAX_MEMORY_CONTENT_CHARS);
    vi.unstubAllGlobals();
  });

  it("reports a non-OK response instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
    const result = await saveSupermemoryMemory("fact", "rakazo:bot-123", config);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("401") });
    vi.unstubAllGlobals();
  });
});

describe("saveSupermemoryMemoryToContainers", () => {
  it("writes shared memories to both the workspace and bot containers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      saveSupermemoryMemoryToContainers("fact", ["rakazo:workspace:ws-1", "rakazo:bot-1"], config),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
});

describe("deleteSupermemoryContainer", () => {
  it("deletes the container tag on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await deleteSupermemoryContainer("rakazo:bot-123", config);

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://localhost:6767/v3/container-tags/rakazo%3Abot-123");
    expect(init.method).toBe("DELETE");
    expect(init.redirect).toBe("error");
    vi.unstubAllGlobals();
  });

  // DELETE /v3/container-tags/{containerTag} responses from the Supermemory OpenAPI spec.
  it.each([
    [200, { ok: true }],
    [404, { ok: true }],
    [403, { ok: false, error: SUPERMEMORY_DELETE_FORBIDDEN_ERROR }],
    [401, { ok: false, error: "Supermemory container delete failed: 401" }],
    [500, { ok: false, error: "Supermemory container delete failed: 500" }],
  ] satisfies [number, SupermemorySaveResponse][])(
    "maps a %i response",
    async (status, expected) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status })));
      await expect(deleteSupermemoryContainer("rakazo:bot-123", config)).resolves.toEqual(expected);
    },
  );
});

describe("probeSupermemory", () => {
  it("succeeds when the container-tags endpoint responds", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await probeSupermemory(config);
    expect(result).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0]![1].redirect).toBe("error");
    vi.unstubAllGlobals();
  });

  it("fails when the endpoint rejects the key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));
    const result = await probeSupermemory(config);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("401") });
    vi.unstubAllGlobals();
  });

  it("fails when nothing is listening", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));
    const result = await probeSupermemory(config);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("unreachable") });
    vi.unstubAllGlobals();
  });
});

describe("private-host transport", () => {
  const pinned = [{ address: "172.18.0.4", family: 4 as const }];

  it("rechecks pinned addresses without resolving the name again", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    const resolveHostname = vi.fn();

    const result = await searchSupermemory("query", "fake:tag", {
      baseUrl: "http://supermemory:6767",
      apiKey: "sm_test_key",
      resolveHostname,
      pinnedAddresses: pinned,
      fetch: fetchMock,
    });

    expect(result).toEqual({ ok: true, results: [] });
    expect(resolveHostname).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects a pinned public address before the request", async () => {
    const fetchMock = vi.fn();
    const resolveHostname = vi.fn();

    const result = await searchSupermemory("query", "fake:tag", {
      baseUrl: "http://supermemory:6767",
      apiKey: "sm_test_key",
      resolveHostname,
      pinnedAddresses: [{ address: "203.0.113.10", family: 4 }],
      fetch: fetchMock,
    });

    expect(result.ok).toBe(false);
    expect(resolveHostname).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // A finished Response from a stub hides this: the dispatcher close waits for
  // the body, and the caller cannot read that body until close returns.
  it("reads a body that arrives after the response headers", async () => {
    const payload = JSON.stringify({ results: [{ memory: "late", similarity: 1 }] });
    const server = createServer((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
      setTimeout(() => response.end(payload), 50);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      await expect(
        searchSupermemory(
          "query",
          "fake:tag",
          {
            baseUrl: `http://supermemory:${port}`,
            apiKey: "sm_test_key",
            resolveHostname: async () => [{ address: "127.0.0.1", family: 4 }],
          },
          undefined,
          AbortSignal.timeout(2_000),
        ),
      ).resolves.toEqual({ ok: true, results: [{ memory: "late", similarity: 1 }] });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("cancels unread probe, save, and delete bodies", async () => {
    const sockets = new Set<Socket>();
    const server = createServer((request, response) => {
      // A local tool can probe any listening loopback port; only Supermemory calls
      // are answered and count towards the sockets the client must release.
      if (!/^\/v[34]\//.test(request.url ?? "")) {
        request.resume();
        response.writeHead(404).end();
        return;
      }
      sockets.add(request.socket);
      request.socket.on("close", () => sockets.delete(request.socket));
      request.resume();
      response.writeHead(request.url?.includes("search") ? 500 : 200, {
        "content-type": "application/json",
      });
      response.flushHeaders();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const connection = {
      baseUrl: `http://supermemory:${port}`,
      apiKey: "sm_test_key",
      resolveHostname: async () => [{ address: "127.0.0.1", family: 4 as const }],
    };
    try {
      await expect(probeSupermemory(connection)).resolves.toEqual({ ok: true });
      await expect(saveSupermemoryMemory("fact", "fake:tag", connection)).resolves.toEqual({
        ok: true,
      });
      await expect(deleteSupermemoryContainer("fake:tag", connection)).resolves.toEqual({
        ok: true,
      });
      await expect(searchSupermemory("query", "fake:tag", connection)).resolves.toEqual({
        ok: false,
        error: expect.stringContaining("500"),
      });
      const deadline = Date.now() + 1_000;
      while (sockets.size > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(sockets.size).toBe(0);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
