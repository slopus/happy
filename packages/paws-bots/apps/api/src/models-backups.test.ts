import { RPCHandler } from "@orpc/server/fetch";
import * as adapters from "@rakazo/adapters";
import { listPiCatalog, serializeModelSecret } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const owner: Actor = {
  userId: "user-one",
  spaceId: "space-one",
  email: "one@rakazo.test",
  isDeploymentOwner: true,
};

function setup(
  options: {
    actor?: Actor;
    credits?: boolean;
    existing?: Array<Record<string, unknown>>;
    /** An openai-compatible connection with this stored list and own model. */
    compatible?: { enabledModelIds: string[]; defaultModel: string };
    /** Spaces whose member keeps their own models instead of the account's. */
    overrides?: Array<{ userId: string; spaceId: string }>;
  } = {},
) {
  const credential = {
    id: "credential-one",
    userId: owner.userId,
    provider: options.compatible ? "openai-compatible" : "openrouter",
    label: "fixture",
    secretId: "secret-one",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  // `existing` describes the main model's fallbacks, positioned after its primary. A row
  // with a spaceId is that Space's own copy; one without is the account's.
  let roleRows: Array<Record<string, unknown>> = (options.existing ?? []).map((row) => ({
    ...row,
    role: "main",
    position: Number(row.position) + 1,
    thinkingLevel: null,
  }));
  const roleTable = (copy: "account" | "space") => {
    const owns = (row: Record<string, unknown>, where: Record<string, string>) =>
      (copy === "space") === (row.spaceId !== undefined) &&
      Object.entries(where).every(([key, value]) => row[key] === value);
    return {
      findMany: vi.fn(async ({ where }: { where: Record<string, string> }) =>
        roleRows
          .filter((row) => owns(row, where))
          .sort((left, right) => Number(left.position) - Number(right.position)),
      ),
      deleteMany: vi.fn(async ({ where }: { where: Record<string, string> }) => {
        roleRows = roleRows.filter((row) => !owns(row, where));
        return { count: 0 };
      }),
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        roleRows.push(...data);
        return { count: data.length };
      }),
    };
  };
  const userModelRoleChoice = roleTable("account");
  const spaceModelRoleChoice = roleTable("space");
  type OverrideKey = { spaceId: string; userId: string; setting: string };
  let overrides: OverrideKey[] = (options.overrides ?? []).map((row) => ({
    ...row,
    setting: "models",
  }));
  const sameOverride = (left: OverrideKey, right: OverrideKey) =>
    left.spaceId === right.spaceId &&
    left.userId === right.userId &&
    left.setting === right.setting;
  const spaceSettingOverride = {
    findUnique: vi.fn(
      async ({ where }: { where: { spaceId_userId_setting: OverrideKey } }) =>
        overrides.find((row) => sameOverride(row, where.spaceId_userId_setting)) ?? null,
    ),
    findMany: vi.fn(async ({ where }: { where: { spaceId: string; userId: string } }) =>
      overrides.filter((row) => row.spaceId === where.spaceId && row.userId === where.userId),
    ),
    create: vi.fn(async ({ data }: { data: OverrideKey }) => {
      overrides.push(data);
      return data;
    }),
    delete: vi.fn(async ({ where }: { where: { spaceId_userId_setting: OverrideKey } }) => {
      overrides = overrides.filter((row) => !sameOverride(row, where.spaceId_userId_setting));
      return where.spaceId_userId_setting;
    }),
  };
  const tx = {
    userModelRoleChoice,
    spaceModelRoleChoice,
    spaceSettingOverride,
    $queryRaw: vi.fn().mockResolvedValue([{ locked: 1 }]),
  };
  const prisma = {
    deploymentSettings: { findUnique: vi.fn(async () => null), findFirst: vi.fn(async () => null) },
    // Saved choices that keep a model listed after new users stop being offered it.
    bot: { findMany: vi.fn(async () => []) },
    routine: { findMany: vi.fn(async () => []) },
    space: {
      findFirst: vi.fn(async () => ({ organization: { modelCredits: { mode: "credits" } } })),
    },
    userModelRoleChoice,
    spaceModelRoleChoice,
    spaceSettingOverride,
    userModelCredential: {
      findMany: vi.fn(async ({ where }: { where: { userId: string; provider?: string } }) =>
        !options.credits &&
        where.userId === owner.userId &&
        (!where.provider || where.provider === credential.provider)
          ? [credential]
          : [],
      ),
      findFirst: vi.fn(async ({ where }: { where: { id?: string; userId: string } }) =>
        !options.credits && where.userId === owner.userId && where.id === credential.id
          ? { ...credential, userPreferences: [] }
          : null,
      ),
    },
    userModelPreference: {
      findMany: vi.fn().mockResolvedValue(
        options.compatible
          ? [
              {
                modelId: options.compatible.defaultModel,
                thinkingLevel: null,
                updatedAt: new Date(0),
                credential,
              },
            ]
          : [],
      ),
      findFirst: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
    secret: {
      findMany: vi.fn().mockResolvedValue([{ id: "secret-one", ciphertext: "fixture-ciphertext" }]),
      findFirst: vi.fn().mockResolvedValue({ id: "secret-one", ciphertext: "fixture-ciphertext" }),
    },
    $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
  } as unknown as PrismaClient;
  Object.assign(tx, {
    userModelPreference: prisma.userModelPreference,
    userModelCredential: prisma.userModelCredential,
  });
  const deps = {
    billing: options.credits ? { modelCreditsEnabled: true } : undefined,
    prisma,
    secrets: {
      // A fixture ciphertext that is already a stored secret decrypts to itself.
      load: vi.fn((ciphertext: string) =>
        ciphertext.startsWith("{")
          ? ciphertext
          : options.compatible
            ? serializeModelSecret({
                kind: "openai_compatible",
                baseUrl: "http://127.0.0.1:11434/v1",
                enabledModelIds: options.compatible.enabledModelIds,
              })
            : "fake-api-key-for-offline-tests",
      ),
    },
    env: {
      agentRuntime: "pi",
      defaultProvider: "openrouter",
      defaultModel: "unused-test-model",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fixture-secret",
      sandboxProvider: "fake",
    },
    dataDir: "C:/scratch/rakazo-model-backups",
  } as unknown as RouterDeps;
  const actor = options.actor ?? owner;
  const handler = new RPCHandler(createRouter(deps));
  const call = async (procedure: string, input: unknown) => {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/${procedure}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    if (!response) throw new Error(`no response for ${procedure}`);
    return { response };
  };
  const roles = () => roleRows;
  // The main model's fallbacks in the shape `existing` takes.
  const rows = () =>
    roleRows
      .filter((row) => row.role === "main" && Number(row.position) > 0)
      .map(({ userId, spaceId, provider, modelId, position }) => ({
        userId,
        spaceId,
        provider,
        modelId,
        position: Number(position) - 1,
      }));
  return { rows, roles, prisma, userModelRoleChoice, spaceModelRoleChoice, call };
}

const availableModel = listPiCatalog().find(
  (entry) => entry.provider === "openrouter" && !entry.placeholder,
)!;

describe("model catalog offered to pickers", () => {
  it("leaves out models agents cannot run but keeps one the account saved", async () => {
    const { call, prisma } = setup();
    const saved = "openai/gpt-5.5-pro:batch";
    vi.mocked(prisma.bot.findMany).mockResolvedValue([
      { modelProvider: "openrouter", modelId: saved },
    ] as never);

    const { response } = await call("models/list", null);

    expect(response?.status).toBe(200);
    const { json } = (await response!.json()) as {
      json: Array<{ provider: string; id: string }>;
    };
    const openrouter = json.filter((entry) => entry.provider === "openrouter");
    expect(
      openrouter.filter((entry) => entry.id.endsWith(":batch")).map((entry) => entry.id),
    ).toEqual([saved]);
    expect(openrouter.some((entry) => entry.id === "anthropic/claude-haiku-5.5")).toBe(true);
  });
});

describe("model backup settings API", () => {
  it("rejects a compatible catalog placeholder outside the enabled list", async () => {
    const { call, userModelRoleChoice } = setup({
      compatible: { enabledModelIds: ["enabled"], defaultModel: "enabled" },
    });
    const { response } = await call("models/setBackups", [
      { provider: "openai-compatible", modelId: "custom" },
    ]);
    expect(response.status).toBe(400);
    expect(userModelRoleChoice.createMany).not.toHaveBeenCalled();
  });

  it("reads the member's account list, ignoring stale Space copies and other users", async () => {
    const { call, prisma } = setup({
      existing: [
        { userId: "user-one", provider: "openrouter", modelId: "first", position: 0 },
        {
          userId: "user-one",
          spaceId: "space-one",
          provider: "openrouter",
          modelId: "stale-space-copy",
          position: 0,
        },
        { userId: "user-two", provider: "openrouter", modelId: "other-user", position: 0 },
      ],
    });

    const { response } = await call("models/backups", null);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      json: [{ provider: "openrouter", modelId: "first" }],
    });
    expect(prisma.userModelRoleChoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: owner.userId, role: "main" } }),
    );
  });

  it("reads and writes a Space's own list while it overrides the account's", async () => {
    const { call, rows } = setup({
      overrides: [{ userId: owner.userId, spaceId: owner.spaceId }],
      existing: [
        { userId: owner.userId, provider: "openrouter", modelId: "account", position: 0 },
        {
          userId: owner.userId,
          spaceId: owner.spaceId,
          provider: "openrouter",
          modelId: "space-own",
          position: 0,
        },
      ],
    });

    const legacy = await call("models/backups", null);
    expect((await legacy.response.json()).json).toEqual([
      { provider: "openrouter", modelId: "space-own" },
    ]);
    const account = await call("models/role", { role: "main", scope: "account" });
    expect((await account.response.json()).json.backups).toEqual([
      expect.objectContaining({ modelId: "account" }),
    ]);

    const input = [{ provider: availableModel.provider, modelId: availableModel.id }];
    expect((await call("models/setBackups", input)).response.status).toBe(200);
    expect(rows()).toEqual([
      expect.objectContaining({ modelId: "account" }),
      expect.objectContaining({ spaceId: owner.spaceId, modelId: availableModel.id }),
    ]);

    // An explicit account write leaves the Space's copy alone.
    const accountWrite = await call("models/setRole", {
      role: "main",
      scope: "account",
      backups: [],
    });
    expect(accountWrite.response.status).toBe(200);
    expect(rows()).toEqual([
      expect.objectContaining({ spaceId: owner.spaceId, modelId: availableModel.id }),
    ]);
  });

  it("persists an ordered list for a connected usable model without changing the primary", async () => {
    const { call, prisma, rows, roles } = setup();
    const input = [{ provider: availableModel.provider, modelId: availableModel.id }];

    const { response } = await call("models/setBackups", input);

    expect(response.status).toBe(200);
    // An installed app's backup list writes the main role.
    expect(roles()).toEqual([
      expect.objectContaining({ role: "main", position: 1, modelId: availableModel.id }),
    ]);
    expect(rows()).toEqual([
      {
        userId: owner.userId,
        provider: availableModel.provider,
        modelId: availableModel.id,
        position: 0,
      },
    ]);
    const preferences = (
      prisma as unknown as {
        userModelPreference: {
          upsert: ReturnType<typeof vi.fn>;
          updateMany: ReturnType<typeof vi.fn>;
        };
      }
    ).userModelPreference;
    expect(preferences.upsert).not.toHaveBeenCalled();
    expect(preferences.updateMany).not.toHaveBeenCalled();
  });

  it("rejects disconnected models, duplicate targets, and lists over the configured bound", async () => {
    const disconnected = setup();
    const invalid = await disconnected.call("models/setBackups", [
      { provider: "not-connected", modelId: "unknown-model" },
    ]);
    expect(invalid.response.status).toBeGreaterThanOrEqual(400);
    expect(disconnected.userModelRoleChoice.deleteMany).not.toHaveBeenCalled();

    const duplicate = setup();
    const repeated = { provider: availableModel.provider, modelId: availableModel.id };
    const duplicateResponse = await duplicate.call("models/setBackups", [repeated, repeated]);
    expect(duplicateResponse.response.status).toBeGreaterThanOrEqual(400);
    expect(duplicate.userModelRoleChoice.deleteMany).not.toHaveBeenCalled();

    const oversized = setup();
    const tooMany = Array.from({ length: 11 }, (_, index) => ({
      provider: availableModel.provider,
      modelId: `${availableModel.id}-${index}`,
    }));
    const oversizedResponse = await oversized.call("models/setBackups", tooMany);
    expect(oversizedResponse.response.status).toBeGreaterThanOrEqual(400);
    expect(oversized.userModelRoleChoice.deleteMany).not.toHaveBeenCalled();
  });

  it("rejects a known catalog model when its provider is disconnected without replacing saved backups", async () => {
    const disconnectedModel = listPiCatalog().find(
      (entry) => entry.provider === "anthropic" && !entry.placeholder,
    )!;
    const existing = {
      userId: owner.userId,
      provider: availableModel.provider,
      modelId: availableModel.id,
      position: 0,
    };
    const { call, userModelRoleChoice, rows } = setup({ existing: [existing] });

    const { response } = await call("models/setBackups", [
      { provider: disconnectedModel.provider, modelId: disconnectedModel.id },
    ]);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      json: { message: "Connect that model provider first" },
    });
    expect(userModelRoleChoice.deleteMany).not.toHaveBeenCalled();
    expect(userModelRoleChoice.createMany).not.toHaveBeenCalled();
    expect(rows()).toEqual([existing]);
  });

  it("accepts a backup on a second enabled openai-compatible model", async () => {
    const { call, rows } = setup({
      compatible: { enabledModelIds: ["local-a", "local-b"], defaultModel: "local-a" },
    });

    const { response } = await call("models/setBackups", [
      { provider: "openai-compatible", modelId: "local-b" },
    ]);

    expect(response.status).toBe(200);
    expect(rows()).toEqual([
      expect.objectContaining({ provider: "openai-compatible", modelId: "local-b", position: 0 }),
    ]);
  });

  it("rejects a backup on an openai-compatible model outside the enabled list", async () => {
    const { call, userModelRoleChoice } = setup({
      compatible: { enabledModelIds: ["local-a"], defaultModel: "local-a" },
    });

    const { response } = await call("models/setBackups", [
      { provider: "openai-compatible", modelId: "local-z" },
    ]);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      json: { message: "Unknown model for that provider" },
    });
    expect(userModelRoleChoice.deleteMany).not.toHaveBeenCalled();
  });

  it("isolates writes between users", async () => {
    const actor: Actor = {
      ...owner,
      userId: "user-two",
      spaceId: "space-two",
      email: "two@rakazo.test",
    };
    const kept = { userId: owner.userId, provider: "openrouter", modelId: "keep", position: 0 };
    const { rows, call, userModelRoleChoice } = setup({ actor, existing: [kept] });

    await call("models/setBackups", []);

    expect(rows()).toEqual([kept]);
    expect(userModelRoleChoice.deleteMany).toHaveBeenCalledWith({
      where: { userId: actor.userId, role: "main" },
    });
  });
});

describe("Space model overrides", () => {
  it("starts a Space's own models from the account's and drops them when it follows again", async () => {
    const { call, rows } = setup({
      existing: [{ userId: owner.userId, provider: "openrouter", modelId: "account", position: 0 }],
    });
    const overrides = async () =>
      (await (await call("spaceSettings/overrides", null)).response.json()).json;
    expect(await overrides()).toEqual([]);

    const customize = await call("spaceSettings/setOverride", { setting: "models", enabled: true });
    expect((await customize.response.json()).json).toEqual(["models"]);
    expect(rows()).toEqual([
      expect.objectContaining({ modelId: "account" }),
      expect.objectContaining({ spaceId: owner.spaceId, modelId: "account" }),
    ]);

    // Changes now land in the Space's copy only.
    expect((await call("models/setBackups", [])).response.status).toBe(200);
    expect(rows()).toEqual([expect.objectContaining({ modelId: "account" })]);

    const reset = await call("spaceSettings/setOverride", { setting: "models", enabled: false });
    expect((await reset.response.json()).json).toEqual([]);
    expect(await overrides()).toEqual([]);
    const legacy = await call("models/backups", null);
    expect((await legacy.response.json()).json).toEqual([
      { provider: "openrouter", modelId: "account" },
    ]);
  });
});

const visionModel = listPiCatalog().find(
  (entry) => entry.provider === "openrouter" && !entry.placeholder && entry.images,
)!;
const textOnlyModel = listPiCatalog().find(
  (entry) => entry.provider === "openrouter" && !entry.placeholder && entry.images === false,
)!;

describe("role-based model settings API", () => {
  it("saves a computer-use model only when it can see images", async () => {
    const { call } = setup();
    const accepted = await call("models/setRole", {
      role: "computer",
      primary: { provider: "openrouter", modelId: visionModel.id },
    });
    expect(accepted.response.status).toBe(200);
    const refused = await call("models/setRole", {
      role: "computer",
      primary: { provider: "openrouter", modelId: textOnlyModel.id },
    });
    expect(refused.response.status).toBe(400);
  });
  it("says whether the main model reads images, as computer use decides it", async () => {
    const { call } = setup();
    const seesImages = async (modelId: string) => {
      const saved = await call("models/setRole", {
        role: "main",
        primary: { provider: "openrouter", modelId },
      });
      expect(saved.response.status).toBe(200);
      const read = await call("models/role", { role: "main" });
      return (await read.response.json()).json.seesImages;
    };
    expect(await seesImages(visionModel.id)).toBe(true);
    expect(await seesImages(textOnlyModel.id)).toBe(false);
    const approval = await call("models/role", { role: "approval" });
    expect((await approval.response.json()).json.seesImages).toBeUndefined();
  });
  it("offers only image-capable models for computer use", async () => {
    const { call } = setup();
    const { response } = await call("models/forRole", { role: "computer" });
    const entries: Array<{ id: string; images?: boolean }> = (await response.json()).json;
    expect(entries.some((entry) => entry.id === visionModel.id)).toBe(true);
    expect(entries.some((entry) => entry.images === false)).toBe(false);
  });
  it("accepts a decision model pinned to the provider's only connection", async () => {
    const { call } = setup();
    const primary = {
      provider: "openrouter",
      modelId: "typesafe/jev-1.14",
      credentialId: "credential-one",
    };
    const { response } = await call("models/setRole", { role: "approval", primary });
    expect(response.status).toBe(200);
    expect((await response.json()).json.primary).toMatchObject(primary);
  });
  it("stores approval choices independently of main backups using the existing connection", async () => {
    const { call, rows, prisma } = setup();
    const primary = { provider: "openrouter", modelId: "typesafe/jev-1.14" };
    const { response } = await call("models/setRole", {
      role: "approval",
      primary,
      backups: [{ provider: availableModel.provider, modelId: availableModel.id }],
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.json.primary).toEqual(primary);
    expect(prisma.userModelRoleChoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: owner.userId, role: "approval" } }),
    );
    const read = await call("models/role", { role: "approval" });
    expect((await read.response.json()).json).toEqual(body.json);
    expect(rows()).toEqual([]);
  });
  it("filters decision models out of main choices and rejects saving them for main", async () => {
    const { call } = setup();
    const main = await call("models/forRole", { role: "main" });
    expect(
      (await main.response.json()).json.some(
        (entry: { protocol?: string }) => entry.protocol === "decisions",
      ),
    ).toBe(false);
    const approval = await call("models/forRole", { role: "approval" });
    expect((await approval.response.json()).json).toContainEqual(
      expect.objectContaining({ id: "typesafe/jev-1.14", protocol: "decisions" }),
    );
    const invalid = await call("models/setRole", {
      role: "main",
      primary: { provider: "openrouter", modelId: "typesafe/jev-1.14" },
    });
    expect(invalid.response.status).toBe(400);
  });
  it("rejects stale sessions and unavailable connections without replacing settings", async () => {
    const { call } = setup();
    const stale = await call("models/setRole", {
      role: "approval",
      expectedUserId: "different-user",
      primary: null,
    });
    expect(stale.response.status).toBe(403);
    const missing = await call("models/setRole", {
      role: "approval",
      primary: { provider: "not-connected", modelId: "model" },
    });
    expect(missing.response.status).toBe(400);
    const read = await call("models/role", { role: "approval" });
    expect((await read.response.json()).json).toMatchObject({ primary: null, backups: [] });
  });
  it("lists the same model on two connections, each validated on its own", async () => {
    const { call, prisma, roles } = setup();
    const connections = ["credential-personal", "credential-work"];
    const findFirst = vi.fn(async ({ where }: { where: { id: string; userId: string } }) =>
      connections.includes(where.id) && where.userId === owner.userId
        ? {
            id: where.id,
            userId: owner.userId,
            provider: "openrouter",
            label: where.id,
            secretId: `${where.id}-secret`,
            createdAt: new Date(0),
            updatedAt: new Date(0),
            userPreferences: [],
          }
        : null,
    );
    Object.assign(prisma.userModelCredential, { findFirst });
    const model = { provider: availableModel.provider, modelId: availableModel.id };
    const primary = { ...model, credentialId: "credential-personal" };
    const backup = { ...model, credentialId: "credential-work" };

    const { response } = await call("models/setRole", {
      role: "main",
      primary,
      backups: [backup],
    });
    expect(response.status).toBe(200);
    expect((await response.json()).json).toMatchObject({ primary, backups: [backup] });
    expect(roles().map((row) => [row.position, row.credentialId])).toEqual([
      [0, "credential-personal"],
      [1, "credential-work"],
    ]);
    for (const id of connections)
      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id }) }),
      );

    // A row may only run on a connection the member still has.
    const gone = await call("models/setRole", {
      role: "main",
      primary: { ...model, credentialId: "credential-removed" },
    });
    expect(gone.response.status).toBe(400);
  });
  it("offers and accepts a model only on the connections that can run it", async () => {
    const { call, prisma } = setup();
    const connection = (id: string) => ({
      id,
      userId: owner.userId,
      provider: "openrouter",
      label: id,
      secretId: `${id}-secret`,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      userPreferences: [],
    });
    Object.assign(prisma.userModelCredential, {
      findMany: vi.fn(async () => [
        connection("credential-personal"),
        connection("credential-work"),
      ]),
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => connection(where.id)),
    });
    const serves = vi
      .spyOn(adapters, "connectionServesModel")
      .mockImplementation(
        async (_deps, _userId, credential, _provider, modelId) =>
          modelId !== availableModel.id || credential.secretId === "credential-personal-secret",
      );
    try {
      const catalog = (await (await call("models/forRole", { role: "main" })).response.json())
        .json as Array<{ id: string; credentialIds?: string[] }>;
      expect(catalog.find((entry) => entry.id === availableModel.id)?.credentialIds).toEqual([
        "credential-personal",
      ]);
      const model = { provider: availableModel.provider, modelId: availableModel.id };
      const wrong = await call("models/setRole", {
        role: "main",
        primary: { ...model, credentialId: "credential-work" },
      });
      expect(wrong.response.status).toBe(400);
      const right = await call("models/setRole", {
        role: "main",
        primary: { ...model, credentialId: "credential-personal" },
      });
      expect(right.response.status).toBe(200);
    } finally {
      serves.mockRestore();
    }
  });
  it("reads each connection's key and the saved choices once for the whole catalog", async () => {
    const { call, prisma } = setup();
    const connection = (id: string) => ({
      id,
      userId: owner.userId,
      provider: "openrouter",
      label: id,
      secretId: `${id}-secret`,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      userPreferences: [],
    });
    Object.assign(prisma.userModelCredential, {
      findMany: vi.fn(async () => [
        connection("credential-personal"),
        connection("credential-work"),
      ]),
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => connection(where.id)),
    });
    const secretRow = ({ where }: { where: { id: string } }) => ({
      id: where.id,
      ciphertext: `ciphertext-${where.id}`,
    });
    const findSecret = vi.fn(async (args: { where: { id: string } }) => secretRow(args));
    Object.assign(prisma.secret, {
      findFirst: findSecret,
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => secretRow({ where: { id } })),
      ),
    });
    // The work account's live list adds models the personal one does not list.
    const bundled = listPiCatalog()
      .filter((entry) => entry.provider === "openrouter" && !entry.placeholder)
      .map((entry) => entry.id);
    const liveOnly = bundled.slice(0, 20).map((id) => `${id}-preview`);
    const lists = vi
      .spyOn(adapters.ProviderCatalogCache.prototype, "read")
      .mockImplementation(async ({ secretId }) =>
        secretId === "credential-personal-secret" ? bundled : [...bundled, ...liveOnly],
      );
    vi.stubEnv("RAKAZO_LIVE_MODEL_CATALOG", "on");
    try {
      const catalog = (await (await call("models/forRole", { role: "main" })).response.json())
        .json as Array<{ id: string; credentialIds?: string[] }>;
      expect(catalog.filter((entry) => liveOnly.includes(entry.id))).toHaveLength(20);
      expect(catalog.find((entry) => entry.id === liveOnly[0])?.credentialIds).toEqual([
        "credential-work",
      ]);
      expect(findSecret).toHaveBeenCalledTimes(2);
      // Once for the catalog itself and once for the connections that may serve it.
      expect(prisma.bot.findMany).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllEnvs();
      lists.mockRestore();
    }
  });
  it("keeps the main model's effort when a list save repeats its primary", async () => {
    const { call, prisma, roles } = setup();
    const [thinking, other] = listPiCatalog().filter(
      (entry) =>
        entry.provider === "openrouter" &&
        !entry.placeholder &&
        entry.thinkingLevels?.includes("high"),
    );
    const primary = { provider: thinking!.provider, modelId: thinking!.id };
    const first = await call("models/setRole", {
      role: "main",
      primary: { ...primary, thinkingLevel: "high" },
    });
    expect(first.response.status).toBe(200);
    const preferences = prisma.userModelPreference as unknown as {
      upsert: ReturnType<typeof vi.fn>;
    };
    preferences.upsert.mockClear();

    const backups = [{ provider: other!.provider, modelId: other!.id }];
    const { response } = await call("models/setRole", { role: "main", primary, backups });
    expect(response.status).toBe(200);

    expect((await response.json()).json.primary).toEqual({ ...primary, thinkingLevel: "high" });
    expect(roles()[0]).toMatchObject({ position: 0, thinkingLevel: "high" });
    // The main model lives only in its role; the connection's own choice is untouched.
    expect(preferences.upsert).not.toHaveBeenCalled();
  });

  it("serves a compatible main model from the connection that enables it", async () => {
    // Connection A owns the model; model B is enabled only on connection B.
    const { call, prisma, roles } = setup({
      compatible: { enabledModelIds: ["model-a"], defaultModel: "model-a" },
    });
    const connection = (id: string) => ({
      id,
      userId: owner.userId,
      provider: "openai-compatible",
      label: id,
      secretId: `secret-${id}`,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    const [connectionA, connectionB] = [connection("a"), connection("b")];
    const client = prisma as unknown as {
      userModelCredential: { findMany: ReturnType<typeof vi.fn> };
      userModelPreference: {
        findMany: ReturnType<typeof vi.fn>;
        upsert: ReturnType<typeof vi.fn>;
      };
      secret: { findFirst: ReturnType<typeof vi.fn> };
    };
    client.userModelCredential.findMany.mockResolvedValue([connectionA, connectionB]);
    client.userModelPreference.findMany.mockResolvedValue([
      {
        modelId: "model-a",
        thinkingLevel: null,
        updatedAt: new Date(0),
        credential: connectionA,
      },
    ]);
    client.secret.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      ciphertext: serializeModelSecret({
        kind: "openai_compatible",
        baseUrl: "http://127.0.0.1:11434/v1",
        enabledModelIds: [where.id === connectionB.secretId ? "model-b" : "model-a"],
      }),
    }));
    const { response } = await call("models/setRole", {
      role: "main",
      primary: { provider: "openai-compatible", modelId: "model-b" },
    });

    expect(response.status).toBe(200);
    expect(roles()).toEqual([
      expect.objectContaining({ position: 0, provider: "openai-compatible", modelId: "model-b" }),
    ]);
    expect(client.userModelPreference.upsert).not.toHaveBeenCalled();
  });

  it("retains backwards-compatible main backup storage", async () => {
    const { call } = setup();
    const backups = [{ provider: availableModel.provider, modelId: availableModel.id }];
    expect((await call("models/setRole", { role: "main", backups })).response.status).toBe(200);
    const legacy = await call("models/backups", {});
    expect((await legacy.response.json()).json).toEqual(backups);
  });
});

it("lets a deployment-managed model lead the main model like any other purpose", async () => {
  vi.stubEnv("PI_DEFAULT_PROVIDER", "openrouter");
  vi.stubEnv("OPENROUTER_API_KEY", "fake-hosted-key");
  try {
    const { call, prisma, roles } = setup({ credits: true });
    const primary = { provider: availableModel.provider, modelId: availableModel.id };
    const catalog = await call("models/forRole", { role: "main" });
    expect((await catalog.response.json()).json).toContainEqual(
      expect.objectContaining({ id: primary.modelId, managed: true }),
    );
    const main = await call("models/setRole", { role: "main", primary });
    expect(main.response.status).toBe(200);
    expect(roles()).toEqual([expect.objectContaining({ role: "main", position: 0 })]);
    const preferences = prisma.userModelPreference as unknown as {
      upsert: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    expect(preferences.upsert).not.toHaveBeenCalled();
    expect(preferences.updateMany).not.toHaveBeenCalled();
    const approval = await call("models/setRole", { role: "approval", primary });
    expect(approval.response.status).toBe(200);
  } finally {
    vi.unstubAllEnvs();
  }
});
