import type { AdapterContext, ManagedConnectorProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { InfisicalSecretStore } from "./infisical-secret-store.js";
import {
  IntegrationProviderSettings,
  prepareManagedConnectorForTransaction,
} from "./integration-provider-settings.js";
import { infisicalFake } from "./secret-store-fake.js";
import { EncryptedSecretStore } from "./secrets.js";

const context: AdapterContext = {
  operationId: "test",
  traceId: "test",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};
function fixture() {
  const rows = new Map<string, { id: string; ciphertext: string }>();
  const prisma = {
    integrationProviderConfig: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null),
      upsert: vi.fn(async ({ create }: { create: { id: string; ciphertext: string } }) => {
        rows.set(create.id, create);
        return create;
      }),
    },
  };
  const adapter = {
    listConnectedExternalIds: vi.fn(async () => []),
    catalog: vi.fn(async () => []),
    discoverTools: vi.fn(async () => []),
  } as unknown as ManagedConnectorProvider;
  const factory = vi.fn(() => adapter);
  const secrets = new EncryptedSecretStore("test-encryption-key");
  const settings = new IntegrationProviderSettings(
    prisma as unknown as PrismaClient,
    secrets,
    "test-identity",
    {},
    factory,
  );
  return { rows, prisma, adapter, factory, secrets, settings };
}
describe("integration provider settings", () => {
  it.each([true, false])("forwards app tools with discovery fallback: %s", async (hasCatalog) => {
    const f = fixture();
    const tools = [{ name: "example_action", description: "An action", inputSchema: {} }];
    const listAppTools = vi.fn(async () => tools);
    if (hasCatalog) f.adapter.listAppTools = listAppTools;
    vi.mocked(f.adapter.discoverTools).mockResolvedValue(tools);
    await f.settings.save({ provider: "composio", apiKey: "fake-key" }, context);
    const provider = f.settings.providers().find((entry) => entry.describe().id === "composio")!;
    expect(await provider.listAppTools!(context, "example")).toEqual(tools);
    if (hasCatalog) {
      expect(listAppTools).toHaveBeenCalledWith(context, "example");
      expect(f.adapter.discoverTools).not.toHaveBeenCalled();
    } else {
      expect(f.adapter.discoverTools).toHaveBeenCalledWith(context);
    }
  });
  it("encrypts credentials and shares updates with a separately created worker resolver", async () => {
    const f = fixture();
    const worker = new IntegrationProviderSettings(
      f.prisma as unknown as PrismaClient,
      f.secrets,
      "test-identity",
      {},
      f.factory,
    );
    expect(await worker.resolve("composio")).toBeUndefined();
    await f.settings.save({ provider: "composio", apiKey: "fake-first-key" }, context);
    expect(JSON.stringify([...f.rows.values()])).not.toContain("fake-first-key");
    expect(await worker.resolve("composio")).toBe(f.adapter);
    expect(f.factory).toHaveBeenLastCalledWith({ provider: "composio", apiKey: "fake-first-key" });
    await f.settings.save({ provider: "composio", apiKey: "fake-replacement-key" }, context);
    await worker.resolve("composio");
    expect(f.factory).toHaveBeenLastCalledWith({
      provider: "composio",
      apiKey: "fake-replacement-key",
    });
  });
  it("lists connected plugin slugs for the user, or none before setup", async () => {
    const f = fixture();
    expect(await f.settings.listConnectedPluginSlugs("user-1")).toEqual([]);
    await f.settings.save({ provider: "composio", apiKey: "fake-plugin-key" }, context);
    vi.mocked(f.adapter.listConnectedExternalIds).mockResolvedValueOnce(["gmail"]);
    expect(await f.settings.listConnectedPluginSlugs("user-1")).toEqual(["gmail"]);
    expect(f.adapter.listConnectedExternalIds).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: "user-1" }),
    );
  });
  it("preserves working settings and hides provider error details on failed verification", async () => {
    const f = fixture();
    await f.settings.save({ provider: "composio", apiKey: "fake-working-key" }, context);
    const before = f.rows.get("composio");
    vi.mocked(f.adapter.listConnectedExternalIds).mockRejectedValueOnce(
      new Error("fake-secret-in-provider-response"),
    );
    await expect(
      f.settings.save({ provider: "composio", apiKey: "fake-bad-key" }, context),
    ).rejects.toThrow("Could not verify these credentials");
    expect(f.rows.get("composio")).toBe(before);
  });
  it("declines routeless lookups for unconfigured providers but still requires setup for routed calls", async () => {
    const f = fixture();
    for (const provider of f.settings.providers()) {
      expect(await provider.catalog(context)).toEqual([]);
      expect(await provider.discoverTools(context)).toEqual([]);
      const call = { tool: "mcp__demo__read", args: {}, executionId: "watch" };
      await expect(provider.resolveCall?.(call, context)).resolves.toBeUndefined();
      await expect(
        provider.resolveCall?.(
          { ...call, route: { connectorId: provider.describe().id, toolName: "read" } },
          context,
        ),
      ).rejects.toThrow("Set up an integration provider");
      await expect(
        provider.begin({ provider: "slack", redirectUrl: "https://example.test" }, context),
      ).rejects.toThrow("Set up an integration provider");
    }
    expect(f.factory).not.toHaveBeenCalled();
  });
  it("propagates configured provider resolution errors", async () => {
    const f = fixture();
    const error = new Error("Tool access denied");
    const resolveCall = vi.fn().mockRejectedValue(error);
    f.adapter.resolveCall = resolveCall;
    await f.settings.save({ provider: "composio", apiKey: "fake-key" }, context);
    const provider = f.settings.providers().find((entry) => entry.describe().id === "composio")!;
    const call = { tool: "read", args: {}, executionId: "watch" };
    await expect(provider.resolveCall?.(call, context)).rejects.toBe(error);
    expect(resolveCall).toHaveBeenCalledWith(call, context);
  });
  it("warms directories only for configured providers", async () => {
    const f = fixture();
    const warm = vi.fn(async () => undefined);
    const adapter = {
      listConnectedExternalIds: vi.fn(async () => []),
      catalog: vi.fn(async () => []),
      discoverTools: vi.fn(async () => []),
      warmDirectory: warm,
    } as unknown as ManagedConnectorProvider;
    f.factory.mockReturnValue(adapter);
    const fallbackWarm = vi.fn(async () => undefined);
    const settings = new IntegrationProviderSettings(
      f.prisma as unknown as PrismaClient,
      f.secrets,
      "test-identity",
      {
        pipedream: {
          warmDirectory: fallbackWarm,
        } as unknown as ManagedConnectorProvider,
      },
      f.factory,
    );
    settings.warmDirectories();
    await vi.waitFor(() => expect(fallbackWarm).toHaveBeenCalledOnce());
    expect(warm).not.toHaveBeenCalled();
    await settings.save({ provider: "composio", apiKey: "fake-warm-key" }, context);
    settings.warmDirectories();
    await vi.waitFor(() => expect(warm).toHaveBeenCalledOnce());
  });
  it.each([false, true, undefined])(
    "forwards the prepared provider's reconnect requirement %s",
    async (reconnect) => {
      const f = fixture();
      const needsReconnect = vi.fn(async () => reconnect ?? false);
      if (reconnect !== undefined) f.adapter.needsReconnect = needsReconnect;
      await f.settings.save({ provider: "composio", apiKey: "fake-key" }, context);
      const wrapper = f.settings
        .providers()
        .find((provider) => provider.describe().id === "composio")!;
      const { provider } = await prepareManagedConnectorForTransaction(wrapper);

      expect(await provider?.needsReconnect?.(context, "gmail")).toBe(reconnect ?? false);
      if (reconnect !== undefined) {
        expect(needsReconnect).toHaveBeenCalledExactlyOnceWith(context, "gmail");
      } else {
        expect(needsReconnect).not.toHaveBeenCalled();
      }
    },
  );
  it("exposes the prepared provider's account resolution bound to that provider", async () => {
    const f = fixture();
    class AccountAdapter {
      private readonly accounts = new Map([["request-1", "account-1"]]);
      async listConnectedExternalIds() {
        return [];
      }
      async resolveConnectedAccountId(_userId: string, _slug: string, ref?: string | null) {
        return ref ? this.accounts.get(ref) : undefined;
      }
    }
    f.factory.mockReturnValue(new AccountAdapter() as unknown as ManagedConnectorProvider);
    await f.settings.save({ provider: "composio", apiKey: "fake-key" }, context);
    const wrapper = f.settings
      .providers()
      .find((provider) => provider.describe().id === "composio");

    const { provider } = await prepareManagedConnectorForTransaction(wrapper!);
    const resolve = provider?.resolveConnectedAccountId;

    expect(provider?.cancelAuthorizationRequest).toBeUndefined();
    await expect(resolve?.("user", "gmail", "request-1")).resolves.toBe("account-1");
  });
});

describe("integration credentials with Infisical", () => {
  it("reloads external rotation and does not retain credentials expired during a slow save", async () => {
    vi.useFakeTimers();
    const fake = infisicalFake();
    const store = new InfisicalSecretStore({
      ...fake.options,
      cacheTtlMs: 100,
      cacheMaxEntries: 1,
    });
    await store.start();
    let row: { id: string; ciphertext: string } | undefined;
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const saving = new Promise<void>((resolve) => {
      started = resolve;
    });
    const prisma = {
      integrationProviderConfig: {
        findUnique: vi.fn(async () => row),
        upsert: vi.fn(async ({ create }: { create: { id: string; ciphertext: string } }) => {
          row = create;
          started();
          await gate;
          return row;
        }),
      },
    };
    const adapter = {
      listConnectedExternalIds: vi.fn(async () => []),
    } as unknown as ManagedConnectorProvider;
    const factory = vi.fn(() => adapter);
    const settings = new IntegrationProviderSettings(
      prisma as unknown as PrismaClient,
      store,
      "fake",
      {},
      factory,
    );
    try {
      const pending = settings.save({ provider: "composio", apiKey: "fake-initial" }, context);
      await saving;
      fake.values.set(
        row!.ciphertext.split(":").at(-1)!,
        JSON.stringify({ provider: "composio", apiKey: "fake-rotated" }),
      );
      await vi.advanceTimersByTimeAsync(100);
      release();
      await pending;
      const changed = vi.fn();
      store.onChange(changed);
      await settings.resolve("composio");
      expect(changed).toHaveBeenCalledExactlyOnceWith(row!.ciphertext);
      expect(factory).toHaveBeenLastCalledWith({ provider: "composio", apiKey: "fake-rotated" });
      changed.mockClear();
      const calls = factory.mock.calls.length;
      await vi.advanceTimersByTimeAsync(100);
      await settings.resolve("composio");
      expect(factory).toHaveBeenCalledTimes(calls);
      expect(changed).not.toHaveBeenCalled();
      await store.put("unrelated", context);
      changed.mockClear();
      fake.values.set(
        row!.ciphertext.split(":").at(-1)!,
        JSON.stringify({ provider: "composio", apiKey: "fake-again" }),
      );
      await vi.advanceTimersByTimeAsync(100);
      await settings.resolve("composio");
      expect(factory).toHaveBeenLastCalledWith({ provider: "composio", apiKey: "fake-again" });
      expect(changed).not.toHaveBeenCalled();
    } finally {
      release();
      await store.close();
      vi.useRealTimers();
    }
  });
});
