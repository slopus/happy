import type { ComputerRef } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { ComputerProviderSelection, StoredComputerSettings } from "./configured-sandbox.js";
import {
  ConfiguredSandbox,
  loadComputerOwnerSettings,
  loadComputerProviderSelection,
  parseStoredComputerSettings,
} from "./configured-sandbox.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";

class TestDesktop {
  readonly calls: string[] = [];
  keepsDisk = true;
  provider(desktopId = "ecd-fake") {
    const provider = new FakeSandboxProvider();
    const provision = provider.provision.bind(provider);
    const descriptor = provider.describe();
    return Object.assign(provider, {
      describe: () => ({
        ...descriptor,
        id: "desktop",
        capabilities: { ...descriptor.capabilities, persistentHome: this.keepsDisk },
      }),
      provision: async (...args: Parameters<typeof provision>) => ({
        ...(await provision(...args)),
        kind: "desktop",
        providerRef: desktopId,
      }),
      ownsReference: (computer: ComputerRef) =>
        computer.kind === "desktop" && computer.providerRef === desktopId,
      billsWhileRunning: () => true,
      listFiles: async () => {
        this.calls.push("listFiles");
        return [];
      },
    });
  }
}

const ctx = {
  operationId: "1",
  traceId: "1",
  spaceId: "s",
  userId: "u",
  signal: new AbortController().signal,
};

const values = {
  accessKeyId: "test-id",
  accessKeySecret: "test-secret",
  regionId: "cn-hangzhou",
  desktopId: "ecd-fake",
  endUserId: "end-user",
  mcpUrl: "https://gateway.example.com/mcp",
  mcpToken: "test-token",
};

const settings: StoredComputerSettings = { provider: "desktop", values };

function setup(initial: ComputerProviderSelection) {
  let selection = initial;
  const primary = new FakeSandboxProvider();
  const desktop = new TestDesktop();
  const ownDesktop = new TestDesktop();
  /** The desktop each home key's owner saved for themselves. */
  const own = new Map<string, StoredComputerSettings>();
  const sandbox = new ConfiguredSandbox(primary, async () => selection, {
    loadOwn: async (homeKey) => own.get(homeKey) ?? null,
    createProvider: async (chosen) =>
      chosen.values.desktopId === settings.values.desktopId
        ? desktop.provider()
        : ownDesktop.provider(chosen.values.desktopId),
  });
  return {
    sandbox,
    desktop,
    ownDesktop,
    own,
    select: async (next: ComputerProviderSelection) => {
      selection = next;
      await sandbox.refresh();
    },
  };
}

describe("ConfiguredSandbox", () => {
  it("sends new computers to the provider chosen in Settings", async () => {
    const { sandbox, select } = setup({ provider: "default", settings: null });
    await sandbox.refresh();
    expect(await sandbox.provisionKind()).toBe("fake");
    expect((await sandbox.provision({ botId: "a", homePath: "/h" }, ctx)).kind).toBe("fake");

    await select({ provider: "desktop", settings });
    expect(sandbox.describe().id).toBe("desktop");
    expect(await sandbox.provisionKind()).toBe("desktop");
    expect((await sandbox.provision({ botId: "b", homePath: "/h" }, ctx)).kind).toBe("desktop");
  });

  it("keeps every existing computer on the provider of its own kind", async () => {
    const { sandbox, select, desktop } = setup({ provider: "desktop", settings });
    await sandbox.refresh();
    const onSelected = await sandbox.provision({ botId: "w", homePath: "/h" }, ctx);
    await select({ provider: "default", settings });
    const onPrimary = await sandbox.provision(
      {
        botId: "p",
        homePath: "/h",
        providerRef: onSelected.providerRef,
        providerKind: "desktop",
      },
      ctx,
    );
    // A selected provider reference means nothing to the deployment's own provider.
    expect(onPrimary).toMatchObject({ kind: "fake", fresh: true });

    await sandbox.prepare(onSelected, ctx);
    desktop.calls.length = 0;
    await sandbox.listFiles(onSelected, "", ctx);
    expect(desktop.calls.some((call) => call === "listFiles")).toBe(true);
    expect(sandbox.billsWhileRunning(onSelected)).toBe(true);
  });

  it("runs an account's Team Computer on the desktop it saved, and the rest on the default", async () => {
    const { sandbox, desktop, ownDesktop, own } = setup({ provider: "desktop", settings });
    own.set("mine", { ...settings, values: { ...values, desktopId: "ecd-own" } });
    await sandbox.refresh();
    expect(await sandbox.provisionKind("mine")).toBe("desktop");
    const mine = await sandbox.provision({ botId: "mine", homePath: "/h" }, ctx);
    const theirs = await sandbox.provision({ botId: "theirs", homePath: "/h" }, ctx);
    expect(mine.providerRef).toBe("ecd-own");
    expect(theirs.providerRef).toBe("ecd-fake");

    await sandbox.prepare(mine, ctx);
    desktop.calls.length = 0;
    ownDesktop.calls.length = 0;
    await sandbox.listFiles(mine, "", ctx);
    expect(ownDesktop.calls.some((call) => call === "listFiles")).toBe(true);
    expect(desktop.calls).toEqual([]);
  });

  it("keeps a computer on the default desktop until it starts again on its owner's", async () => {
    const { sandbox, desktop, own } = setup({ provider: "desktop", settings });
    await sandbox.refresh();
    const before = await sandbox.provision({ botId: "mine", homePath: "/h" }, ctx);
    own.set("mine", { ...settings, values: { ...values, desktopId: "ecd-own" } });
    await sandbox.refresh();

    await sandbox.prepare(before, ctx);
    desktop.calls.length = 0;
    await sandbox.listFiles(before, "", ctx);
    expect(desktop.calls.some((call) => call === "listFiles")).toBe(true);
    const after = await sandbox.provision(
      {
        botId: "mine",
        homePath: "/h",
        providerRef: before.providerRef,
        providerKind: "desktop",
      },
      ctx,
    );
    expect(after).toMatchObject({ providerRef: "ecd-own", fresh: true });
  });

  it("uses an account's own desktop even when the deployment default is a different provider", async () => {
    const { sandbox, own } = setup({ provider: "default", settings: null });
    own.set("mine", { ...settings, values: { ...values, desktopId: "ecd-own" } });
    await sandbox.refresh();
    expect(await sandbox.provisionKind()).toBe("fake");
    expect(await sandbox.provisionKind("mine")).toBe("desktop");
    expect((await sandbox.provision({ botId: "mine", homePath: "/h" }, ctx)).kind).toBe("desktop");
  });

  it("reads an owner's desktop only for Team Computers", async () => {
    const secretRow = { id: "s1", ciphertext: "c1" };
    const findFirst = vi.fn(async () => secretRow);
    const prisma = (scope: string) =>
      ({
        computer: { findUnique: async () => ({ userId: "u1", scope }) },
        secret: { findFirst },
      }) as unknown as PrismaClient;
    const secrets = { load: async () => JSON.stringify(settings) };
    expect(await loadComputerOwnerSettings(prisma("team"), secrets, "team-k")).toEqual({
      ...settings,
      ciphertext: "c1",
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u1", spaceId: null, kind: "computer-provider" },
      }),
    );
    findFirst.mockClear();
    expect(await loadComputerOwnerSettings(prisma("dedicated"), secrets, "bot-k")).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("probes background work for providers without their own check", async () => {
    const { sandbox } = setup({ provider: "default", settings: null });
    const computer: ComputerRef = await sandbox.provision({ botId: "a", homePath: "/h" }, ctx);
    await expect(sandbox.inspectBackgroundWork(computer, "marker", ctx)).resolves.toMatch(
      /^(active|idle)$/,
    );
  });

  it("reads the deployment's connection from its own settings row", async () => {
    const prisma = {
      deploymentSettings: {
        findUnique: async () => ({ computerProvider: "desktop", computerProviderCipher: "c1" }),
      },
    } as unknown as PrismaClient;
    const load = vi.fn(async () => JSON.stringify(settings));
    expect(await loadComputerProviderSelection(prisma, { load })).toEqual({
      provider: "desktop",
      settings: { ...settings, ciphertext: "c1" },
    });
    expect(load).toHaveBeenCalledWith("c1", "deployment-computer-provider");
  });

  it("falls back to the deployment provider when the saved connection no longer decrypts", async () => {
    const prisma = {
      deploymentSettings: {
        findUnique: async () => ({ computerProvider: "desktop", computerProviderCipher: "old" }),
      },
    };
    const secrets = {
      load: async () => {
        throw new Error("unable to decrypt");
      },
    };
    expect(await loadComputerProviderSelection(prisma as unknown as PrismaClient, secrets)).toEqual(
      { provider: "default", settings: null },
    );
    // Routing never mistakes an unreadable store for a removed connection.
    await expect(
      loadComputerProviderSelection(prisma as unknown as PrismaClient, secrets, true),
    ).rejects.toThrow("unable to decrypt");
  });

  it("reads only complete saved provider settings", () => {
    expect(parseStoredComputerSettings(JSON.stringify(settings))).toEqual(settings);
    expect(
      parseStoredComputerSettings(
        JSON.stringify({ ...settings, values: { ...values, regionId: "" } }),
      )?.values.regionId,
    ).toBe("");
    expect(
      parseStoredComputerSettings(
        JSON.stringify({ ...settings, values: { ...values, mcpToken: "" } }),
      ),
    ).toBeNull();
    expect(parseStoredComputerSettings("not json")).toBeNull();
  });
});

it("reuses adapters only for the same ciphertext and credentials, and invalidates on secret changes", async () => {
  let saved: StoredComputerSettings = { ...settings, ciphertext: "encrypted-1" };
  let changed: ((ref: string) => void) | undefined;
  const createProvider = vi.fn(async () => new FakeSandboxProvider());
  const load = vi.fn(async () => ({ provider: saved.provider, settings: saved }));
  const sandbox = new ConfiguredSandbox(new FakeSandboxProvider(), load, {
    createProvider,
    onSecretChange: (listener) => {
      changed = listener;
      return () => {};
    },
  });
  await sandbox.provisionKind();
  await sandbox.provisionKind();
  // Starts within the window reuse the settings already read.
  expect(load).toHaveBeenCalledTimes(1);
  expect(createProvider).toHaveBeenCalledTimes(1);
  changed?.("encrypted-1");
  await sandbox.refresh();
  expect(createProvider).toHaveBeenCalledTimes(2);
  saved = { ...saved, ciphertext: "encrypted-2" };
  await sandbox.refresh();
  expect(createProvider).toHaveBeenCalledTimes(3);
  saved = { ...saved, values: { ...values, mcpToken: "replacement-token" } };
  await sandbox.refresh();
  expect(createProvider).toHaveBeenCalledTimes(4);
});

it("routes an existing computer through a retained deployment connection after a provider switch", async () => {
  const { sandbox, select, desktop } = setup({ provider: "desktop", settings });
  const computer = await sandbox.provision({ botId: "a", homePath: "/h" }, ctx);
  await select({
    provider: "test-cloud",
    settings: {
      provider: "test-cloud",
      values: { apiKey: "test-key" },
      connections: { desktop: values },
    },
  });
  await sandbox.prepare(computer, ctx);
  desktop.calls.length = 0;
  await sandbox.listFiles(computer, "", ctx);
  expect(desktop.calls.some((call) => call === "listFiles")).toBe(true);
});

it("asks the retained connection, not the selected provider, whether a computer keeps its disk", async () => {
  const { sandbox, select, desktop } = setup({ provider: "desktop", settings });
  desktop.keepsDisk = false;
  const computer = await sandbox.provision({ botId: "a", homePath: "/h" }, ctx);
  await select({
    provider: "test-cloud",
    settings: {
      provider: "test-cloud",
      values: { apiKey: "test-key" },
      connections: { desktop: values },
    },
  });
  expect(sandbox.describe().capabilities.persistentHome).toBe(true);
  expect(await sandbox.keepsHome(computer)).toBe(false);
});

it("reports a computer no saved connection reaches as gone, so it can be reset", async () => {
  const { sandbox, select } = setup({ provider: "desktop", settings });
  const computer = await sandbox.provision({ botId: "a", homePath: "/h" }, ctx);
  await select({ provider: "default", settings: null });
  await expect(sandbox.prepare(computer, ctx)).rejects.toMatchObject({
    name: "SandboxNotFoundError",
    message: expect.stringContaining("no longer configured"),
  });
});

it("reads settings at most once per window, and again before calling a computer gone", async () => {
  let selection: ComputerProviderSelection = { provider: "default", settings: null };
  const load = vi.fn(async () => selection);
  const loadOwn = vi.fn(async () => null);
  const desktop = new TestDesktop();
  const sandbox = new ConfiguredSandbox(new FakeSandboxProvider(), load, {
    loadOwn,
    createProvider: async () => desktop.provider(),
  });
  await sandbox.refresh();
  const docker = await sandbox.provision({ botId: "a", homePath: "/h" }, ctx);
  load.mockClear();
  loadOwn.mockClear();
  for (let i = 0; i < 5; i += 1) await sandbox.listFiles(docker, "", ctx);
  // A kind Settings never selects reaches its provider without reading any settings.
  expect(load).not.toHaveBeenCalled();
  expect(loadOwn).not.toHaveBeenCalled();

  // Another instance saves a desktop and starts a computer on it before this one rereads.
  selection = { provider: "desktop", settings };
  const remote = { ...docker, kind: "desktop" as const, providerRef: "ecd-fake" };
  await sandbox.listFiles(remote, "", ctx);
  expect(desktop.calls).toContain("listFiles");
  const reads = load.mock.calls.length;
  for (let i = 0; i < 5; i += 1) await sandbox.listFiles(remote, "", ctx);
  expect(load.mock.calls.length).toBe(reads);
});

it("refuses a desktop reference belonging to another account connection", async () => {
  const { sandbox, own } = setup({ provider: "default", settings: null });
  own.set("mine", { ...settings, values: { ...values, desktopId: "ecd-own" } });
  const computer = await sandbox.provision({ botId: "mine", homePath: "/h" }, ctx);
  await expect(sandbox.prepare({ ...computer, providerRef: "ecd-another" }, ctx)).rejects.toThrow(
    "no longer configured",
  );
});

it("keeps computers the primary started as another of its kinds on the primary", async () => {
  const { sandbox } = setup({ provider: "default", settings: null });
  const computer = await sandbox.provision({ botId: "a", homePath: "/h" }, ctx);
  // The primary now starts new computers elsewhere, as a host-aware primary does when the host is toggled.
  const primary = (sandbox as unknown as { primary: FakeSandboxProvider }).primary;
  Object.assign(primary, { provisionKind: async () => "host" });
  await expect(sandbox.prepare(computer, ctx)).resolves.not.toThrow();
});

vi.mock(
  "./computer-provider-registry.js",
  () => import("./fake-computer-settings.test-support.js"),
);

it("bills a kind only the primary runs the way the primary does", async () => {
  const primary = Object.assign(new FakeSandboxProvider(), {
    billsWhileRunning: (computer: Pick<ComputerRef, "kind">) => computer.kind !== "kubernetes",
  });
  const sandbox = new ConfiguredSandbox(primary, async () => ({
    provider: "default",
    settings: null,
  }));
  const local = {
    id: "c",
    botId: "a",
    kind: "kubernetes",
    providerRef: "k",
  } as unknown as ComputerRef;
  expect(sandbox.billsWhileRunning(local)).toBe(false);
});

it("keeps starting computers on the last settings read while the store is unreadable", async () => {
  let fail = false;
  const sandbox = new ConfiguredSandbox(new FakeSandboxProvider(), async () => {
    if (fail) throw new Error("secret store unavailable");
    return { provider: "default", settings: null };
  });
  await sandbox.refresh();
  fail = true;
  expect(await sandbox.provisionKind("a")).toBe("fake");
  expect((await sandbox.provision({ botId: "a", homePath: "/h" }, ctx)).kind).toBe("fake");
});

it("describes where a computer will start before it has started there", async () => {
  const { sandbox } = setup({ provider: "desktop", settings });
  await sandbox.refresh();
  const environment = { home: "C:\\Users\\bot", shell: "powershell.exe", platform: "win32" };
  const desktop = await (
    sandbox as unknown as { target(homeKey: string): Promise<FakeSandboxProvider> }
  ).target("new");
  Object.assign(desktop, { environment: async () => environment });
  await expect(
    sandbox.environment({ id: "new", botId: "new", kind: "desktop", providerRef: "" }, ctx),
  ).resolves.toEqual(environment);
});

it("keeps routing on the last settings read while the store is unreadable, never calling a computer gone", async () => {
  let fail = false;
  const desktop = new TestDesktop();
  const sandbox = new ConfiguredSandbox(
    new FakeSandboxProvider(),
    async () => {
      if (fail) throw new Error("secret store unavailable");
      return { provider: "desktop", settings };
    },
    { createProvider: async () => desktop.provider() },
  );
  await sandbox.refresh();
  const computer = await sandbox.provision({ botId: "a", homePath: "/h" }, ctx);
  fail = true;
  vi.useFakeTimers({ now: Date.now() + 10_000 });
  try {
    desktop.calls.length = 0;
    await sandbox.listFiles(computer, "", ctx);
    expect(desktop.calls).toContain("listFiles");
    await expect(sandbox.prepare({ ...computer, providerRef: "ecd-unknown" }, ctx)).rejects.toThrow(
      "secret store unavailable",
    );
  } finally {
    vi.useRealTimers();
  }
});
