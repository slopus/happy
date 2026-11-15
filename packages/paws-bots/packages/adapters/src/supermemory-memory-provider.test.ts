import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolveHostname } from "./network-address.js";
import { MemoryProviderPrivateEndpointRequiredError } from "./serenity-memory-provider.js";
import { SUPERMEMORY_DELETE_FORBIDDEN_ERROR } from "./supermemory-client.js";
import {
  prepareSupermemoryConnection,
  SupermemoryMemoryProvider,
} from "./supermemory-memory-provider.js";

const context: AdapterContext = {
  operationId: "op-1",
  traceId: "trace-1",
  spaceId: "workspace-1",
  userId: "user-1",
  botId: "bot-1",
  signal: new AbortController().signal,
};

function provider() {
  return new SupermemoryMemoryProvider({
    baseUrl: "http://localhost:6767",
    apiKey: "sm_test_key",
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("SupermemoryMemoryProvider", () => {
  it("keeps Supermemory namespaces inside the adapter and omits empty history", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await provider().recall(
      { query: "project", scope: "shared", botId: "bot-1", limit: 5 },
      context,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).containerTag),
    ).toEqual(["rakazo:workspace:workspace-1", "rakazo:bot-1"]);
  });

  it("adds the current history generation only after compaction", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await provider().recall(
      {
        query: "project",
        scope: "isolated",
        botId: "bot-1",
        historyGeneration: 3,
        limit: 5,
      },
      context,
    );

    expect(
      fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).containerTag),
    ).toEqual(["rakazo:bot-1", "rakazo:bot-1:history:3"]);
  });

  it("passes recall limits and cancellation through to the provider client", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await provider().recall(
      { query: "project", scope: "isolated", botId: "bot-1", limit: 2 },
      { ...context, signal: controller.signal },
    );

    const init = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body)).limit).toBe(2);
    expect(init?.signal.aborted).toBe(true);
  });

  it("mirrors shared durable saves so a later scope change retains bot memory", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await provider().save(
      {
        content: "Use metric units.",
        scope: "shared",
        botId: "bot-1",
        source: { kind: "durable" },
      },
      context,
    );

    expect(
      fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).containerTag),
    ).toEqual(["rakazo:workspace:workspace-1", "rakazo:bot-1"]);
  });

  it("purges only requested history generations", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await provider().purgeHistory({ botId: "bot-1", generations: [2, 3, 3] }, context);

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "http://localhost:6767/v3/container-tags/rakazo%3Abot-1%3Ahistory%3A2",
      "http://localhost:6767/v3/container-tags/rakazo%3Abot-1%3Ahistory%3A3",
    ]);
  });

  it("purges a generation that never got a container", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 404 })));
    await expect(
      provider().purgeHistory({ botId: "bot-1", generations: [4, 5] }, context),
    ).resolves.toEqual({ ok: true, value: undefined });
  });

  it("reports a purge the key is not allowed to make", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 403 })));
    await expect(
      provider().purgeHistory({ botId: "bot-1", generations: [4] }, context),
    ).resolves.toEqual({ ok: false, error: SUPERMEMORY_DELETE_FORBIDDEN_ERROR });
  });

  it.each(["", "  "])("recalls nothing for an empty query without searching", async (query) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      provider().recall({ query, scope: "shared", botId: "bot-1", limit: 5 }, context),
    ).resolves.toEqual({ ok: true, value: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fetch when a saved local base URL is a public address", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await new SupermemoryMemoryProvider({
      baseUrl: "http://203.0.113.10:6767",
      apiKey: "sm_test_key",
    }).recall({ query: "project", scope: "isolated", botId: "bot-1", limit: 1 }, context);

    expect(result).toEqual({
      ok: false,
      error: "Local mode requires a loopback or private-network address.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const credentials = { apiKey: "sm_test_key" };
const privateResolver = async () => [{ address: "172.18.0.4", family: 4 as const }];
const publicResolver = async () => [{ address: "203.0.113.10", family: 4 as const }];

describe("Supermemory connection setup", () => {
  function setupFetch(deleteStatus: number) {
    return vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
      init?.method === "DELETE"
        ? new Response("{}", { status: deleteStatus })
        : Response.json(
            { containerTags: [] },
            { status: String(url).endsWith("/list") ? 200 : 404 },
          ),
    );
  }

  it("checks that the key may delete memory without deleting real data", async () => {
    const fetchMock = setupFetch(404);
    vi.stubGlobal("fetch", fetchMock);
    await prepareSupermemoryConnection({ mode: "cloud" }, credentials);
    expect(fetchMock.mock.calls.map(([url, init]) => [init?.method, String(url)])).toEqual([
      ["GET", "https://api.supermemory.ai/v3/container-tags/list"],
      [
        "DELETE",
        expect.stringMatching(
          /^https:\/\/api\.supermemory\.ai\/v3\/container-tags\/rakazo%3Adelete-probe%3A[0-9a-f-]{36}$/,
        ),
      ],
    ]);
  });

  it("rejects a key that cannot delete memory from cleared conversations", async () => {
    vi.stubGlobal("fetch", setupFetch(403));
    await expect(prepareSupermemoryConnection({ mode: "cloud" }, credentials)).rejects.toThrow(
      SUPERMEMORY_DELETE_FORBIDDEN_ERROR,
    );
  });
});

describe("Supermemory local base URL", () => {
  it("accepts loopback", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) => new Response("[]"),
    );
    vi.stubGlobal("fetch", fetchMock);

    const prepared = await prepareSupermemoryConnection(
      { mode: "local", baseUrl: "http://127.0.0.1:6767" },
      credentials,
      { allowPrivateEndpoint: true },
    );

    expect(prepared.settings).toEqual({ mode: "local", baseUrl: "http://127.0.0.1:6767" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:6767/v3/container-tags/list");
  });

  it.each(["http://10.0.0.8:6767", "http://192.168.1.20:6767", "http://[fd00::1]:6767"])(
    "accepts private literal %s for the deployment owner",
    async (baseUrl) => {
      const fetchMock = vi.fn(
        async (_url: string | URL | Request, _init?: RequestInit) => new Response("[]"),
      );
      vi.stubGlobal("fetch", fetchMock);

      const prepared = await prepareSupermemoryConnection({ mode: "local", baseUrl }, credentials, {
        allowPrivateEndpoint: true,
      });

      expect(prepared.settings.baseUrl).toBe(baseUrl);
      expect(fetchMock.mock.calls[0]?.[0]).toBe(`${baseUrl}/v3/container-tags/list`);
    },
  );

  it("accepts a Compose service name that resolves to a private address", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) => new Response("[]"),
    );
    const resolveHostname = vi.fn(privateResolver);

    const prepared = await prepareSupermemoryConnection(
      { mode: "local", baseUrl: "http://supermemory:6767" },
      credentials,
      { allowPrivateEndpoint: true, resolveHostname, fetch: fetchMock },
    );

    expect(prepared.settings).toEqual({ mode: "local", baseUrl: "http://supermemory:6767" });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://supermemory:6767/v3/container-tags/list",
    );
    expect(resolveHostname).toHaveBeenCalledOnce();
  });

  it("accepts Docker Desktop and private-suffix hosts that resolve privately", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) => new Response("[]"),
    );

    await prepareSupermemoryConnection(
      { mode: "local", baseUrl: "http://host.docker.internal:6767" },
      credentials,
      {
        allowPrivateEndpoint: true,
        resolveHostname: async () => [{ address: "192.168.65.254", family: 4 as const }],
        fetch: fetchMock,
      },
    );

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://host.docker.internal:6767/v3/container-tags/list",
    );
  });

  it.each(["http://example.com:6767", "https://memory.example.com"])(
    "rejects public host %s",
    async (baseUrl) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        prepareSupermemoryConnection({ mode: "local", baseUrl }, credentials, {
          allowPrivateEndpoint: true,
          resolveHostname: publicResolver,
        }),
      ).rejects.toThrow(/private-network/);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("rejects a Compose name that resolves to a public address", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      prepareSupermemoryConnection(
        { mode: "local", baseUrl: "http://supermemory:6767" },
        credentials,
        { allowPrivateEndpoint: true, resolveHostname: publicResolver },
      ),
    ).rejects.toThrow(/private-network/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects the Supermemory Cloud URL as a local endpoint", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      prepareSupermemoryConnection(
        { mode: "local", baseUrl: "https://api.supermemory.ai" },
        credentials,
        { allowPrivateEndpoint: true, resolveHostname: privateResolver },
      ),
    ).rejects.toThrow(/Cloud URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects cloud metadata and link-local targets", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      prepareSupermemoryConnection(
        { mode: "local", baseUrl: "http://169.254.169.254/latest/meta-data/" },
        credentials,
        { allowPrivateEndpoint: true },
      ),
    ).rejects.toThrow(/blocked address/);
    await expect(
      prepareSupermemoryConnection(
        { mode: "local", baseUrl: "https://nas.local:6767" },
        credentials,
        {
          allowPrivateEndpoint: true,
          resolveHostname: async () => [{ address: "169.254.170.2", family: 4 as const }],
        },
      ),
    ).rejects.toThrow(/blocked address/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects private endpoints for a non-owner before DNS or probe", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const resolveHostname = vi.fn(privateResolver);

    await expect(
      prepareSupermemoryConnection(
        { mode: "local", baseUrl: "http://10.0.0.8:6767" },
        credentials,
        { allowPrivateEndpoint: false, resolveHostname },
      ),
    ).rejects.toBeInstanceOf(MemoryProviderPrivateEndpointRequiredError);
    await expect(
      prepareSupermemoryConnection(
        { mode: "local", baseUrl: "http://supermemory:6767" },
        credentials,
        { allowPrivateEndpoint: false, resolveHostname },
      ),
    ).rejects.toBeInstanceOf(MemoryProviderPrivateEndpointRequiredError);

    expect(resolveHostname).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Supermemory private host reuse", () => {
  function privateProvider(resolveHostname: ResolveHostname, fetchImpl: typeof globalThis.fetch) {
    return new SupermemoryMemoryProvider({
      baseUrl: "http://supermemory:6767",
      apiKey: "sm_test_key",
      resolveHostname,
      fetch: fetchImpl,
    });
  }

  it("resolves a private hostname once for multi-tag recall, save, and purge", async () => {
    const fetchMock = vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const resolveHostname = vi.fn(privateResolver);
    const memory = privateProvider(resolveHostname, fetchMock);

    await expect(
      memory.recall({ query: "project", scope: "shared", botId: "bot-1", limit: 5 }, context),
    ).resolves.toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(resolveHostname).toHaveBeenCalledOnce();

    resolveHostname.mockRejectedValue(new Error("dns blip"));
    await expect(
      memory.recall({ query: "project", scope: "isolated", botId: "bot-1", limit: 1 }, context),
    ).resolves.toMatchObject({ ok: true });
    await memory.save(
      {
        content: "Use metric units.",
        scope: "isolated",
        botId: "bot-1",
        source: { kind: "durable" },
      },
      context,
    );
    await memory.purgeHistory({ botId: "bot-1", generations: [1] }, context);

    expect(resolveHostname).toHaveBeenCalledOnce();
  });

  it("retries a private hostname after a failed lookup", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const resolveHostname = vi
      .fn()
      .mockRejectedValueOnce(new Error("eai_again"))
      .mockResolvedValue([{ address: "172.18.0.4", family: 4 as const }]);
    const memory = privateProvider(resolveHostname, fetchMock);

    await expect(
      memory.recall({ query: "project", scope: "isolated", botId: "bot-1", limit: 1 }, context),
    ).resolves.toEqual({
      ok: false,
      error: "Local mode requires a loopback or private-network address.",
    });
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(
      memory.recall({ query: "project", scope: "isolated", botId: "bot-1", limit: 1 }, context),
    ).resolves.toMatchObject({ ok: true });
    expect(resolveHostname).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
