import { lookup } from "node:dns/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertLocalServiceBaseUrl } from "./local-service-endpoint.js";
import { createMemoryProvider, SpaceMemoryProviderResolver } from "./memory-provider-factory.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

function resolverFor(
  plaintext: string,
  options: {
    provider?: string;
    mode?: "cloud" | "local";
    allowPrivateEndpoint?: boolean;
    baseUrl?: string;
  } = {},
) {
  vi.stubEnv("MCP_ALLOW_PRIVATE_ENDPOINT", options.allowPrivateEndpoint ? "true" : "false");
  const prisma = {
    spaceMemoryConfig: {
      findUnique: vi.fn(async () => ({
        id: "config-1",
        secretId: "secret-1",
        userId: "config-author",
        provider: options.provider ?? "supermemory",
        settings: {
          mode: options.mode ?? "cloud",
          baseUrl: options.baseUrl ?? "https://api.supermemory.ai",
        },
        defaultMemoryScope: "shared",
        secret: { ciphertext: "encrypted" },
      })),
    },
  };
  const secrets = { load: vi.fn(() => plaintext) };
  return {
    resolver: new SpaceMemoryProviderResolver(prisma as never, secrets as never),
    secrets,
    prisma,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("SpaceMemoryProviderResolver", () => {
  it("versions cleanup by stored records, without invalidating it for learning options", async () => {
    const { resolver, prisma } = resolverFor(JSON.stringify({ apiKey: "fake-key" }), {
      provider: "hindsight",
    });
    const config = await prisma.spaceMemoryConfig.findUnique();
    const original = (await resolver.resolve("space-1"))!.provider.connectionIdentity;
    expect(original).toBeTruthy();
    expect((await resolver.resolve("space-1"))!.provider.connectionIdentity).toBe(original);
    prisma.spaceMemoryConfig.findUnique.mockResolvedValue({
      ...config,
      settings: { ...config.settings, retainConversations: "false" },
    } as typeof config);
    expect((await resolver.resolve("space-1"))!.provider.connectionIdentity).toBe(original);
    prisma.spaceMemoryConfig.findUnique.mockResolvedValue({
      ...config,
      secretId: "replacement-secret",
    });
    expect((await resolver.resolve("space-1"))!.provider.connectionIdentity).not.toBe(original);
    prisma.spaceMemoryConfig.findUnique.mockResolvedValue({ ...config, id: "different-config" });
    expect((await resolver.resolve("space-2"))!.provider.connectionIdentity).not.toBe(original);
  });
  it.each(["honcho", "supermemory", "hindsight"])(
    "disables %s without loading credentials when local DNS revalidation fails",
    async (provider) => {
      vi.mocked(lookup).mockRejectedValue(new Error("DNS unavailable"));
      const { resolver, secrets } = resolverFor(JSON.stringify({ apiKey: "fake-key" }), {
        provider,
        mode: "local",
        baseUrl: "http://memory.example.test:8000",
        allowPrivateEndpoint: true,
      });

      await expect(resolver.resolve("workspace-1")).resolves.toBeNull();
      expect(lookup).toHaveBeenCalled();
      expect(secrets.load).not.toHaveBeenCalled();
    },
  );

  it("gates and revalidates saved local Honcho endpoints like other local providers", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const local = { provider: "honcho", mode: "local" as const };

    const notOwner = resolverFor("honcho-admin-token", {
      ...local,
      baseUrl: "http://10.0.0.8:8000",
      allowPrivateEndpoint: false,
    });
    await expect(notOwner.resolver.resolve("workspace-1")).resolves.toBeNull();
    expect(notOwner.secrets.load).not.toHaveBeenCalled();

    const publicHost = resolverFor("honcho-admin-token", {
      ...local,
      baseUrl: "http://203.0.113.10:8000",
      allowPrivateEndpoint: true,
    });
    await expect(publicHost.resolver.resolve("workspace-1")).resolves.toBeNull();
    expect(publicHost.secrets.load).not.toHaveBeenCalled();

    const missingUrl = resolverFor("honcho-admin-token", {
      ...local,
      baseUrl: "",
      allowPrivateEndpoint: true,
    });
    await expect(missingUrl.resolver.resolve("workspace-1")).resolves.toBeNull();
    expect(missingUrl.secrets.load).not.toHaveBeenCalled();

    const owned = resolverFor(JSON.stringify({ apiKey: "honcho-admin-token" }), {
      ...local,
      baseUrl: "http://10.0.0.8:8000",
      allowPrivateEndpoint: true,
    });
    const configured = await owned.resolver.resolve("workspace-1");
    expect(configured?.provider.describe().id).toBe("honcho");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([false, undefined])(
    "disables saved local configurations without explicit operator authorization: %s",
    async (allowPrivateEndpoint) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const { resolver, secrets } = resolverFor("sm_fake_key", {
        mode: "local",
        baseUrl: "http://127.0.0.1:8123/internal-action#",
        allowPrivateEndpoint,
      });

      await expect(resolver.resolve("workspace-1")).resolves.toBeNull();
      expect(secrets.load).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("retains deployment-owner-configured local memory for Space members", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ results: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { resolver } = resolverFor("sm_fake_key", {
      mode: "local",
      baseUrl: "http://localhost:6767/memory/",
      allowPrivateEndpoint: true,
    });
    const configured = await resolver.resolve("workspace-1");
    await configured!.provider.recall(
      { query: "project", scope: "isolated", botId: "bot-1", limit: 1 },
      {
        operationId: "op-1",
        traceId: "trace-1",
        spaceId: "workspace-1",
        userId: "space-member",
        signal: new AbortController().signal,
      },
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:6767/memory/v4/search");
  });

  it("disables ambiguous persisted URLs even when the deployment owner configured them", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { resolver } = resolverFor("sm_fake_key", {
      mode: "local",
      baseUrl: "http://127.0.0.1:8123/internal-action#",
      allowPrivateEndpoint: true,
    });
    await expect(resolver.resolve("workspace-1")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads generic JSON credential payloads", async () => {
    const { resolver } = resolverFor(JSON.stringify({ apiKey: "sm_json_key" }));

    const configured = await resolver.resolve("workspace-1");

    expect(configured?.provider.describe().id).toBe("supermemory");
    expect(configured?.defaultScope).toBe("shared");
  });

  it("keeps legacy raw Supermemory credentials usable after the schema migration", async () => {
    const { resolver } = resolverFor("sm_legacy_key");

    const configured = await resolver.resolve("workspace-1");

    expect(configured?.provider.describe().id).toBe("supermemory");
  });

  it("revalidates persisted provider endpoints before using decrypted credentials", async () => {
    const { resolver, secrets } = resolverFor("sm_fake_key", {
      mode: "local",
      baseUrl: "http://203.0.113.10:6767",
      allowPrivateEndpoint: true,
    });
    await expect(resolver.resolve("workspace-1")).resolves.toBeNull();
    expect(secrets.load).not.toHaveBeenCalled();

    await expect(
      assertLocalServiceBaseUrl("https://memory.example.com", {
        allowPrivateEndpoint: true,
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 as const }],
      }),
    ).rejects.toThrow(/private-network/);
    await expect(
      assertLocalServiceBaseUrl("http://example.com:6767", {
        allowPrivateEndpoint: true,
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 as const }],
      }),
    ).rejects.toThrow(/private-network/);

    expect(() =>
      createMemoryProvider(
        "supermemory",
        { mode: "local", baseUrl: "http://203.0.113.10:6767" },
        { apiKey: "sm_test_key" },
      ),
    ).toThrow(/private-network/);

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = createMemoryProvider(
      "supermemory",
      { mode: "cloud", baseUrl: "https://memory.example.com" },
      { apiKey: "sm_test_key" },
    );

    await provider.recall(
      { query: "project", scope: "isolated", botId: "bot-1", limit: 1 },
      {
        operationId: "op-1",
        traceId: "trace-1",
        spaceId: "workspace-1",
        userId: "user-1",
        signal: new AbortController().signal,
      },
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.supermemory.ai/v4/search");
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
});
