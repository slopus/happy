import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { DeploymentModelDefaults, MemberMainModel } from "./model-roles.js";
import {
  deploymentModelRole,
  effectiveModelRole,
  resolveMemberMainModel,
  selectConfiguredModel,
} from "./model-roles.js";

type SelectionInput = Parameters<typeof selectConfiguredModel>[0];

function credential(provider: string, defaultModel: string | null) {
  return {
    id: `credential-${provider}`,
    userId: "user-1",
    provider,
    label: provider,
    secretId: `secret-${provider}`,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    defaultModel,
    thinkingLevel: null,
  };
}

const scope = { userId: "user-1", spaceId: "space-1" };
const spaceCredential = credential("space-provider", "space-model");
const overrideCredential = credential("bot-provider", "stored-model");
const bot = { modelProvider: "bot-provider", modelId: "bot-model", thinkingLevel: "high" };
const main: MemberMainModel = {
  provider: "space-provider",
  modelId: "space-model",
  credential: spaceCredential,
};
const deploymentDefaults: DeploymentModelDefaults = {
  settings: { defaultModelProvider: "settings-provider", defaultModelId: "settings-model" },
  deployment: { provider: "deployment-provider", model: "deployment-model" },
};
const defaults: SelectionInput = {
  override: null,
  overrideCredential: null,
  main,
  defaults: deploymentDefaults,
};

type RoleRow = {
  role: string;
  position: number;
  provider: string;
  modelId: string;
  thinkingLevel: string | null;
};
function roleClient(rows: RoleRow[]) {
  return {
    spaceSettingOverride: { findUnique: vi.fn(async () => null) },
    userModelRoleChoice: {
      findMany: vi.fn(async ({ where }: { where: { role: string } }) =>
        rows.filter((row) => row.role === where.role),
      ),
    },
  } as unknown as PrismaClient;
}

describe("configured model selection", () => {
  it.each<{
    name: string;
    input: Partial<SelectionInput>;
    expected: ReturnType<typeof selectConfiguredModel>;
  }>([
    {
      name: "uses the bot's model with its own credential",
      input: { override: bot, overrideCredential },
      expected: {
        provider: "bot-provider",
        id: "bot-model",
        credential: overrideCredential,
        thinkingLevel: "high",
      },
    },
    {
      name: "drops override thinking when its provider has no credential",
      input: { override: bot },
      expected: {
        provider: "space-provider",
        id: "space-model",
        credential: spaceCredential,
        thinkingLevel: null,
      },
    },
    {
      name: "keeps bot thinking with the main model",
      input: { override: { modelProvider: null, modelId: null, thinkingLevel: "high" } },
      expected: {
        provider: "space-provider",
        id: "space-model",
        credential: spaceCredential,
        thinkingLevel: "high",
      },
    },
    {
      name: "does not select an incomplete or sentinel bot override",
      input: { override: { ...bot, modelId: "null" }, overrideCredential },
      expected: {
        provider: "space-provider",
        id: "space-model",
        credential: spaceCredential,
        thinkingLevel: "high",
      },
    },
    {
      name: "uses the owner's saved default before the environment's",
      input: { main: null },
      expected: {
        provider: "settings-provider",
        id: "settings-model",
        credential: null,
        thinkingLevel: null,
      },
    },
    {
      name: "uses the environment's model when nothing is saved",
      input: { main: null, defaults: { ...deploymentDefaults, settings: null } },
      expected: {
        provider: "deployment-provider",
        id: "deployment-model",
        credential: null,
        thinkingLevel: null,
      },
    },
    {
      name: "leaves missing configuration for the caller's runtime fallback or failure path",
      input: { main: null, defaults: {} },
      expected: { provider: undefined, id: null, credential: null, thinkingLevel: null },
    },
    {
      name: "falls back to the deployment when the main model's connection is gone",
      input: { main: { ...main, credential: null } },
      expected: {
        provider: "settings-provider",
        id: "settings-model",
        credential: null,
        thinkingLevel: null,
      },
    },
    {
      name: "runs a deployment-managed main model on the funded provider",
      input: {
        main: { provider: "deployment-provider", modelId: "managed-model", credential: null },
        hostedProvider: "deployment-provider",
      },
      expected: {
        provider: "deployment-provider",
        id: "managed-model",
        credential: null,
        thinkingLevel: null,
      },
    },
    {
      name: "applies the main model's own thinking level",
      input: { main: { ...main, thinkingLevel: "low" } },
      expected: {
        provider: "space-provider",
        id: "space-model",
        credential: spaceCredential,
        thinkingLevel: "low",
      },
    },
    {
      name: "bot thinking beats the main model's level",
      input: {
        override: { modelProvider: null, modelId: null, thinkingLevel: "high" },
        main: { ...main, thinkingLevel: "low" },
      },
      expected: {
        provider: "space-provider",
        id: "space-model",
        credential: spaceCredential,
        thinkingLevel: "high",
      },
    },
    {
      name: "does not leak the main model's level onto a different override model",
      input: {
        override: { modelProvider: "bot-provider", modelId: "other-model", thinkingLevel: null },
        overrideCredential,
        main: { ...main, thinkingLevel: "xhigh" },
      },
      expected: {
        provider: "bot-provider",
        id: "other-model",
        credential: overrideCredential,
        thinkingLevel: null,
      },
    },
    {
      name: "inherits the main model's level when the override names that model",
      input: {
        override: { modelProvider: "space-provider", modelId: "space-model", thinkingLevel: null },
        overrideCredential: spaceCredential,
        main: { ...main, thinkingLevel: "xhigh" },
      },
      expected: {
        provider: "space-provider",
        id: "space-model",
        credential: spaceCredential,
        thinkingLevel: "xhigh",
      },
    },
  ])("$name", ({ input, expected }) => {
    expect(selectConfiguredModel({ ...defaults, ...input })).toEqual(expected);
  });
});

describe("model roles", () => {
  it("derives each purpose's deployment default in the shape of a member's choices", () => {
    expect(deploymentModelRole("main", deploymentDefaults)).toEqual({
      primary: { provider: "settings-provider", modelId: "settings-model" },
      backups: [],
    });
    expect(
      deploymentModelRole("approval", {
        env: { RAKAZO_AUTO_REVIEW_PROVIDER: "local-provider", RAKAZO_AUTO_REVIEW_MODEL: "judge" },
      }),
    ).toEqual({ primary: { provider: "local-provider", modelId: "judge" }, backups: [] });
  });

  it("uses the deployment's defaults for a member who chose nothing", async () => {
    await expect(
      effectiveModelRole(roleClient([]), scope, "main", deploymentDefaults),
    ).resolves.toEqual({
      primary: { provider: "settings-provider", modelId: "settings-model" },
      backups: [],
      primarySource: "deployment",
    });
    await expect(effectiveModelRole(roleClient([]), scope, "main", {})).resolves.toEqual({
      primary: null,
      backups: [],
      primarySource: null,
    });
  });

  it("uses the member's own ordered list, with their effort", async () => {
    const prisma = roleClient([
      { role: "main", position: 0, provider: "a", modelId: "m", thinkingLevel: "high" },
      { role: "main", position: 1, provider: "b", modelId: "n", thinkingLevel: null },
      { role: "approval", position: 0, provider: "c", modelId: "o", thinkingLevel: null },
    ]);
    await expect(effectiveModelRole(prisma, scope, "main", deploymentDefaults)).resolves.toEqual({
      primary: { provider: "a", modelId: "m", thinkingLevel: "high" },
      backups: [{ provider: "b", modelId: "n" }],
      primarySource: "member",
    });
  });

  it("follows the account's list unless the Space keeps its own", async () => {
    const account = { role: "main", position: 0, provider: "a", modelId: "account" };
    const own = { role: "main", position: 0, provider: "b", modelId: "space-own" };
    const client = (overridden: boolean) =>
      ({
        spaceSettingOverride: {
          findUnique: vi.fn(async () => (overridden ? { setting: "models" } : null)),
        },
        userModelRoleChoice: { findMany: vi.fn(async () => [{ ...account, userId: "user-1" }]) },
        spaceModelRoleChoice: {
          findMany: vi.fn(async ({ where }: { where: { spaceId: string } }) =>
            where.spaceId === scope.spaceId ? [{ ...own, ...scope }] : [],
          ),
        },
      }) as unknown as PrismaClient;

    await expect(
      effectiveModelRole(client(false), scope, "main", deploymentDefaults),
    ).resolves.toMatchObject({ primary: { modelId: "account" }, primarySource: "member" });
    await expect(
      effectiveModelRole(client(true), scope, "main", deploymentDefaults),
    ).resolves.toMatchObject({ primary: { modelId: "space-own" }, primarySource: "member" });
    // Asking for the account copy reads it even where the Space overrides.
    await expect(
      effectiveModelRole(client(true), scope, "main", deploymentDefaults, "account"),
    ).resolves.toMatchObject({ primary: { modelId: "account" }, primarySource: "member" });
  });

  it("keeps the member's fallbacks behind the deployment's model", async () => {
    const prisma = roleClient([
      { role: "main", position: 1, provider: "b", modelId: "n", thinkingLevel: null },
    ]);
    await expect(effectiveModelRole(prisma, scope, "main", deploymentDefaults)).resolves.toEqual({
      primary: { provider: "settings-provider", modelId: "settings-model" },
      backups: [{ provider: "b", modelId: "n" }],
      primarySource: "deployment",
    });
  });

  it("serves a compatible main model from the connection that enables it", async () => {
    // Connection A is the provider's default; the main model is enabled only on B.
    const connectionA = { ...credential("openai-compatible", "model-a"), id: "a", secretId: "a" };
    const connectionB = { ...credential("openai-compatible", null), id: "b", secretId: "b" };
    const secrets: Record<string, string> = {
      a: JSON.stringify({
        kind: "openai_compatible",
        baseUrl: "https://a.example/v1",
        enabledModelIds: ["model-a"],
      }),
      b: JSON.stringify({
        kind: "openai_compatible",
        baseUrl: "https://b.example/v1",
        enabledModelIds: ["model-b"],
      }),
    };
    const preferences = [
      {
        id: "preference-a",
        credential: connectionA,
        modelId: "model-a",
        thinkingLevel: null,
        updatedAt: new Date(0),
      },
    ];
    const prisma = {
      ...roleClient([
        {
          role: "main",
          position: 0,
          provider: "openai-compatible",
          modelId: "model-b",
          thinkingLevel: null,
        },
      ]),
      userModelPreference: { findMany: vi.fn(async () => preferences) },
      userModelCredential: { findMany: vi.fn(async () => [connectionA, connectionB]) },
      secret: {
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({
          id: where.id,
          ciphertext: secrets[where.id],
        })),
      },
    } as unknown as PrismaClient;

    const resolved = await resolveMemberMainModel(
      { prisma, secretStore: { load: async (plaintext: string) => plaintext } },
      scope,
    );

    expect(resolved).toMatchObject({ provider: "openai-compatible", modelId: "model-b" });
    expect(resolved?.credential?.id).toBe("b");
  });
});
