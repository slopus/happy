import type { SandboxProvider } from "@rakazo/adapter-kit";
import { computerProviderDescriptors } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  effectiveSandboxProvider,
  getAccountComputerSettings,
  getComputerProviderSettings,
  updateAccountComputerSettings,
  updateComputerProviderSettings,
} from "./computer-provider-config.js";

const actor = { userId: "user-1", spaceId: "space-1", email: "admin@example.com" } as never;

const testDesktop = {
  desktopId: "ecd-test",
  endUserId: "test-user",
  mcpUrl: "https://gateway.example.com/mcp",
  accessKeyId: "test-id",
  accessKeySecret: "test-secret",
  mcpToken: "test-token",
};

/** An in-memory deployment settings row and secret table behind the calls the config makes. */
function makeDeps(options: { admin?: boolean; computerSettingsEnabled?: boolean } = {}) {
  const state = {
    settings: null as null | {
      computerProvider: string | null;
      computerProviderCipher: string | null;
    },
    secrets: new Map<string, string>(),
  };
  let nextSecret = 0;
  const prisma = {
    user: {
      findUnique: vi.fn(async () => ({ email: "admin@example.com", emailVerified: true })),
    },
    deploymentSettings: {
      findUnique: vi.fn(async () => state.settings),
      upsert: vi.fn(async ({ update }: { update: Record<string, string | null> }) => {
        state.settings = {
          computerProvider: null,
          computerProviderCipher: null,
          ...state.settings,
          ...update,
        };
        return state.settings;
      }),
    },
    secret: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        state.secrets.has(where.id) ? { id: where.id, ciphertext: where.id } : null,
      ),
      create: vi.fn(async ({ data }: { data: { id: string } }) => ({ id: data.id })),
      deleteMany: vi.fn(async ({ where }: { where: { id: string } }) => {
        state.secrets.delete(where.id);
        return { count: 1 };
      }),
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(prisma)),
  };
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    secrets: {
      put: vi.fn(async (plaintext: string) => {
        const id = `secret-${++nextSecret}`;
        state.secrets.set(id, plaintext);
        return { id, ref: id, ciphertext: id };
      }),
      load: vi.fn(async (ciphertext: string) => state.secrets.get(ciphertext) ?? ""),
      delete: vi.fn(async (ciphertext: string) => {
        state.secrets.delete(ciphertext);
      }),
    },
    sandbox: { describe: () => ({ id: "docker" }) } as unknown as SandboxProvider,
    env: {
      sandboxProvider: "docker",
      adminEmails: options.admin === false ? [] : ["admin@example.com"],
      computerSettingsEnabled: options.computerSettingsEnabled ?? true,
    },
    resolveHostname: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
    verifyConnection: vi.fn(async () => undefined),
  };
  return { deps, state, prisma };
}

describe("computer provider settings", () => {
  it("is for admins only", async () => {
    const { deps } = makeDeps({ admin: false });
    await expect(getComputerProviderSettings(deps, actor)).rejects.toThrow("Admins only");
    await expect(
      updateComputerProviderSettings(deps, actor, {
        provider: "desktop",
        values: testDesktop,
      }),
    ).rejects.toThrow("Admins only");
  });

  it("offers no providers and refuses one unless the deployment enables computer settings", async () => {
    const { deps, state } = makeDeps({ computerSettingsEnabled: false });
    await expect(getComputerProviderSettings(deps, actor)).resolves.toMatchObject({
      provider: "default",
      providers: [],
    });
    await expect(
      updateComputerProviderSettings(deps, actor, { provider: "desktop", values: testDesktop }),
    ).rejects.toThrow("This deployment cannot use computer settings");
    expect(state.secrets.size).toBe(0);
  });

  it("checks the desktop, stores the connection encrypted and never returns secrets", async () => {
    const { deps, state } = makeDeps();
    const saved = await updateComputerProviderSettings(deps, actor, {
      provider: "desktop",
      values: testDesktop,
    });
    expect(deps.verifyConnection).toHaveBeenCalledOnce();
    expect(state.settings).toMatchObject({ computerProvider: "desktop" });
    expect(saved).toMatchObject({
      provider: "desktop",
      defaultProvider: "docker",
      values: { desktopId: "ecd-test", mcpUrl: testDesktop.mcpUrl },
      savedSecrets: { accessKeyId: true, accessKeySecret: true, mcpToken: true },
    });
    expect(saved.values).not.toHaveProperty("accessKeyId");
    expect(JSON.stringify(saved)).not.toContain("test-secret");
    expect(await getComputerProviderSettings(deps, actor)).toEqual(saved);
  });

  it("keeps saved secrets when their fields are left blank", async () => {
    const { deps, state } = makeDeps();
    await updateComputerProviderSettings(deps, actor, {
      provider: "desktop",
      values: testDesktop,
    });
    await updateComputerProviderSettings(deps, actor, {
      provider: "desktop",
      values: { ...testDesktop, desktopId: "ecd-other", accessKeySecret: "", mcpToken: "" },
    });
    const current = state.secrets.get(state.settings?.computerProviderCipher ?? "") ?? "";
    expect(JSON.parse(current).values).toMatchObject({
      desktopId: "ecd-other",
      accessKeySecret: "test-secret",
      mcpToken: "test-token",
    });
    // The replaced ciphertext is removed.
    expect(state.secrets.size).toBe(1);
  });

  it("removes the new ciphertext when saving it fails", async () => {
    const { deps, prisma, state } = makeDeps();
    prisma.deploymentSettings.upsert.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(
      updateComputerProviderSettings(deps, actor, { provider: "desktop", values: testDesktop }),
    ).rejects.toThrow("database unavailable");
    expect(deps.secrets.delete).toHaveBeenCalledWith("secret-1", "deployment-computer-provider");
    expect(state.secrets.size).toBe(0);
  });

  it("sends the saved token only to the gateway it was saved for", async () => {
    const { deps } = makeDeps();
    await updateComputerProviderSettings(deps, actor, {
      provider: "desktop",
      values: testDesktop,
    });
    await expect(
      updateComputerProviderSettings(deps, actor, {
        provider: "desktop",
        values: { ...testDesktop, mcpUrl: "https://other.example.com/mcp", mcpToken: "" },
      }),
    ).rejects.toThrow("Could not verify computer settings");
    expect(deps.verifyConnection).toHaveBeenCalledTimes(1);
  });

  it("refuses incomplete or unreachable settings without saving", async () => {
    const { deps, state } = makeDeps();
    await expect(
      updateComputerProviderSettings(deps, actor, {
        provider: "desktop",
        values: { ...testDesktop, mcpToken: "" },
      }),
    ).rejects.toThrow("Could not verify computer settings");
    deps.verifyConnection.mockRejectedValueOnce(new Error("ConnectionRefused"));
    await expect(
      updateComputerProviderSettings(deps, actor, {
        provider: "desktop",
        values: testDesktop,
      }),
    ).rejects.toThrow("Could not verify computer settings");
    expect(state.settings).toBeNull();
  });

  it("removes the saved keys when switching back to the default", async () => {
    const { deps, state } = makeDeps();
    await updateComputerProviderSettings(deps, actor, {
      provider: "desktop",
      values: testDesktop,
    });
    const back = await updateComputerProviderSettings(deps, actor, {
      provider: "default",
      values: {},
    });
    expect(back.provider).toBe("default");
    expect(back.values).toEqual({});
    expect(state.settings?.computerProvider).toBeNull();
    expect(state.settings?.computerProviderCipher).toBeNull();
    expect(state.secrets.size).toBe(0);
  });

  it("reports the selected provider as the sandbox only with a saved connection", () => {
    expect(effectiveSandboxProvider(null, "docker")).toBe("docker");
    expect(
      effectiveSandboxProvider(
        { computerProvider: "desktop", computerProviderCipher: null },
        "none",
      ),
    ).toBe("none");
    expect(
      effectiveSandboxProvider(
        { computerProvider: "desktop", computerProviderCipher: "c" },
        "none",
      ),
    ).toBe("desktop");
  });
});

type SecretRow = { id: string; userId: string; spaceId: string | null; kind: string };

/** An in-memory secret table that filters the way the account settings query it. */
function makeAccountDeps(sandboxProvider = "docker") {
  const { deps, state } = makeDeps({ admin: false });
  const rows: SecretRow[] = [];
  const matches = (row: SecretRow, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) =>
      value && typeof value === "object" && "not" in value
        ? row[key as keyof SecretRow] !== value.not
        : value && typeof value === "object" && "in" in value
          ? (value.in as unknown[]).includes(row[key as keyof SecretRow])
          : row[key as keyof SecretRow] === value,
    );
  const secret = {
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const row = rows.findLast((candidate) => matches(candidate, where));
      return row ? { id: row.id, ciphertext: row.id } : null;
    }),
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      rows
        .filter((candidate) => matches(candidate, where))
        .map((row) => ({ id: row.id, ciphertext: row.id })),
    ),
    create: vi.fn(async ({ data }: { data: SecretRow }) => {
      rows.push({ id: data.id, userId: data.userId, spaceId: data.spaceId, kind: data.kind });
      return data;
    }),
    deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const before = rows.length;
      rows.splice(0, rows.length, ...rows.filter((row) => !matches(row, where)));
      return { count: before - rows.length };
    }),
  };
  Object.assign(deps.prisma, { secret });
  deps.env.sandboxProvider = sandboxProvider;
  return { deps, state, rows };
}

describe("an account's own computer", () => {
  const other = { userId: "user-2", spaceId: "space-1", email: "other@example.com" } as never;

  it("offers no providers and refuses one unless the deployment enables computer settings", async () => {
    const { deps, rows } = makeAccountDeps();
    deps.env.computerSettingsEnabled = false;
    await expect(getAccountComputerSettings(deps, actor)).resolves.toMatchObject({ providers: [] });
    await expect(
      updateAccountComputerSettings(deps, actor, { provider: "desktop", values: testDesktop }),
    ).rejects.toThrow("This deployment cannot use account computer settings");
    await expect(
      updateAccountComputerSettings(deps, actor, { provider: "default", values: {} }),
    ).resolves.toMatchObject({ provider: "default", providers: [] });
    expect(rows).toEqual([]);
  });

  it("lets any account save its own desktop, kept to that account", async () => {
    const { deps, rows } = makeAccountDeps();
    expect(await getAccountComputerSettings(deps, actor)).toMatchObject({
      provider: "default",
      defaultProvider: "docker",
      values: {},
      savedSecrets: {},
    });
    const saved = await updateAccountComputerSettings(deps, actor, {
      provider: "desktop",
      values: testDesktop,
    });
    expect(deps.verifyConnection).toHaveBeenCalledOnce();
    expect(saved).toMatchObject({
      provider: "desktop",
      defaultProvider: "docker",
      values: { desktopId: "ecd-test" },
      savedSecrets: { accessKeyId: true, accessKeySecret: true, mcpToken: true },
    });
    expect(JSON.stringify(saved)).not.toContain("test-secret");
    // Account-level, so it outlives any one space and no teammate can read it.
    expect(rows).toEqual([
      { id: "secret-1", userId: "user-1", spaceId: null, kind: "computer-provider" },
    ]);
    expect(await getAccountComputerSettings(deps, actor)).toEqual(saved);
    expect((await getAccountComputerSettings(deps, other)).provider).toBe("default");
  });

  it("replaces the saved desktop, keeping blank secrets", async () => {
    const { deps, state, rows } = makeAccountDeps();
    await updateAccountComputerSettings(deps, actor, {
      provider: "desktop",
      values: testDesktop,
    });
    await updateAccountComputerSettings(deps, actor, {
      provider: "desktop",
      values: { ...testDesktop, desktopId: "ecd-other", accessKeySecret: "", mcpToken: "" },
    });
    expect(rows.map((row) => row.id)).toEqual(["secret-2"]);
    expect(deps.secrets.delete).toHaveBeenCalledWith("secret-1", "secret-1");
    expect(JSON.parse(state.secrets.get("secret-2") ?? "").values).toMatchObject({
      desktopId: "ecd-other",
      accessKeySecret: "test-secret",
      mcpToken: "test-token",
    });
  });

  it("goes back to the deployment default by removing the saved desktop", async () => {
    const { deps, rows } = makeAccountDeps();
    await updateAccountComputerSettings(deps, actor, {
      provider: "desktop",
      values: testDesktop,
    });
    await updateAccountComputerSettings(deps, other, {
      provider: "desktop",
      values: testDesktop,
    });
    const back = await updateAccountComputerSettings(deps, actor, {
      provider: "default",
      values: {},
    });
    expect(back).toMatchObject({ provider: "default", defaultProvider: "docker", values: {} });
    expect(rows.map((row) => row.userId)).toEqual(["user-2"]);
    expect(deps.secrets.delete).toHaveBeenCalledWith("secret-1", "secret-1");
    expect(deps.secrets.delete).not.toHaveBeenCalledWith("secret-2", "secret-2");
  });

  it("refuses unreachable desktops and deployments that never route by Settings", async () => {
    const { deps, rows } = makeAccountDeps();
    deps.verifyConnection.mockRejectedValueOnce(new Error("ConnectionRefused"));
    await expect(
      updateAccountComputerSettings(deps, actor, { provider: "desktop", values: testDesktop }),
    ).rejects.toThrow("Could not verify computer settings");
    expect(rows).toEqual([]);
    const local = makeAccountDeps("desktop");
    await expect(
      updateAccountComputerSettings(local.deps, actor, {
        provider: "desktop",
        values: testDesktop,
      }),
    ).rejects.toThrow("This deployment cannot use account computer settings");
    // Without computers, an account's private computers would have nowhere to run.
    const none = makeAccountDeps("none");
    await expect(
      updateAccountComputerSettings(none.deps, actor, { provider: "desktop", values: testDesktop }),
    ).rejects.toThrow("This deployment cannot use account computer settings");
    expect(await getAccountComputerSettings(none.deps, actor)).toMatchObject({ providers: [] });
  });

  it("removes the new keys when saving an account's desktop fails", async () => {
    const { deps, rows } = makeAccountDeps();
    (
      deps.prisma as unknown as { secret: { create: ReturnType<typeof vi.fn> } }
    ).secret.create.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(
      updateAccountComputerSettings(deps, actor, { provider: "desktop", values: testDesktop }),
    ).rejects.toThrow("database unavailable");
    expect(rows).toEqual([]);
    expect(deps.secrets.delete).toHaveBeenCalledWith("secret-1", "secret-1");
  });

  it("lets an account remove its saved desktop after the deployment stops offering one", async () => {
    const { deps, rows } = makeAccountDeps();
    await updateAccountComputerSettings(deps, actor, { provider: "desktop", values: testDesktop });
    deps.env.sandboxProvider = "none";
    expect((await getAccountComputerSettings(deps, actor)).providers.length).toBeGreaterThan(0);
    await updateAccountComputerSettings(deps, actor, { provider: "default", values: {} });
    expect(rows).toEqual([]);
  });
});

// The same API sanitization checks cover every settings-configurable adapter.
it.each(computerProviderDescriptors())(
  "stores $id settings without echoing any credentials",
  async (descriptor) => {
    const { deps } = makeDeps();
    const values = Object.fromEntries(
      descriptor.fields
        .filter((field) => field.required)
        .map((field) => [
          field.key,
          field.kind === "url" ? "https://gateway.example.com/mcp" : "example-value",
        ]),
    );
    const saved = await updateComputerProviderSettings(deps, actor, {
      provider: descriptor.id,
      values,
    });
    for (const field of descriptor.fields) {
      if (field.kind === "secret") {
        expect(saved.values).not.toHaveProperty(field.key);
        expect(saved.savedSecrets[field.key]).toBe(true);
      }
    }
    expect(await getComputerProviderSettings(deps, actor)).toEqual(saved);
  },
);

it("rejects unregistered providers and deployment-only providers for accounts", async () => {
  const { deps } = makeAccountDeps();
  await expect(
    updateAccountComputerSettings(deps, actor, { provider: "unknown", values: {} }),
  ).rejects.toThrow("Could not verify");
  await expect(
    updateAccountComputerSettings(deps, actor, {
      provider: "test-cloud",
      values: { apiKey: "test-key" },
    }),
  ).rejects.toThrow("Could not verify");
});

it("refuses a gateway resolving to a private address before using credentials", async () => {
  const { deps } = makeDeps();
  deps.resolveHostname.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
  await expect(
    updateComputerProviderSettings(deps, actor, { provider: "desktop", values: testDesktop }),
  ).rejects.toThrow("Could not verify");
  expect(deps.verifyConnection).not.toHaveBeenCalled();
  expect(deps.secrets.put).not.toHaveBeenCalled();
});

it("retains previous deployment connections when changing providers", async () => {
  const { deps, state } = makeDeps();
  await updateComputerProviderSettings(deps, actor, {
    provider: "desktop",
    values: testDesktop,
  });
  await updateComputerProviderSettings(deps, actor, {
    provider: "test-cloud",
    values: { apiKey: "test-key" },
  });
  const stored = JSON.parse(state.secrets.get(state.settings!.computerProviderCipher!)!);
  expect(stored).toMatchObject({
    provider: "test-cloud",
    connections: { desktop: testDesktop },
  });
});

vi.mock(
  "../../../packages/adapters/src/computer-provider-registry.js",
  () => import("../../../packages/adapters/src/fake-computer-settings.test-support.js"),
);
