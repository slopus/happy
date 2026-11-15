import { SecretStoreUnavailableError } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { credentialForModel } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { selectConfiguredModel } from "./model-roles.js";
import { serializeModelSecret } from "./model-secret.js";
import {
  connectionServesModel,
  defaultCatalogModelId,
  enabledOpenAiCompatibleModelIds,
  findConnectedModelCredential,
  inboundRoutineModelPin,
  loadStoredModelSecret,
  modelCredentialAuthKindsForSpace,
  pinnedModelCredentialError,
  prepareAllowedThinkingLevels,
  readStoredModelAuth,
  routineRunModelPin,
  runModelChoice,
  selectDefaultCredentialId,
  validateBotModelChange,
  validateConnectedModelChoice,
  validateModelAuthAvailability,
} from "./model-selection.js";
import { listAvailablePiCatalog } from "./pi-catalog-availability.js";
import type { CodexLiveCatalog } from "./pi-codex-catalog.js";
import { liveCatalogEntry, providerCatalogCache } from "./pi-live-catalog.js";
import { listPiCatalog } from "./pi-models.js";

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

const bot = { modelProvider: "bot-provider", modelId: "bot-model", thinkingLevel: "high" };

describe("routine model pin", () => {
  const routine = {
    modelProvider: "routine-provider",
    modelId: "routine-model",
    thinkingLevel: "low",
  };

  it("pins the routine's own model onto its run", () => {
    expect(routineRunModelPin(routine)).toEqual({
      modelProvider: "routine-provider",
      modelId: "routine-model",
      thinkingLevel: "low",
      modelPinned: true,
    });
  });

  it("pins nothing when the routine follows the bot", () => {
    expect(routineRunModelPin({ modelProvider: null, modelId: null, thinkingLevel: null })).toEqual(
      {},
    );
    expect(
      routineRunModelPin({ modelProvider: "routine-provider", modelId: null, thinkingLevel: null }),
    ).toEqual({});
  });

  it("runs a routine turn on the model pinned to its run", () => {
    const choice = runModelChoice({ modelPinned: true, ...routine }, bot);
    expect(choice).toEqual(routine);
    expect(
      selectConfiguredModel({
        main: null,
        defaults: {},
        override: choice,
        overrideCredential: credential("routine-provider", "stored-model"),
      }),
    ).toMatchObject({ provider: "routine-provider", id: "routine-model", thinkingLevel: "low" });
  });

  it("keeps a pinned run on its model after the routine is edited or deleted", () => {
    // The routine row is gone or changed; the run still carries what it fired with.
    expect(runModelChoice({ modelPinned: true, ...routine }, bot)).toEqual(routine);
  });

  it("falls back to the bot for a routine run without a pinned model", () => {
    expect(
      runModelChoice(
        { modelPinned: false, modelProvider: null, modelId: null, thinkingLevel: null },
        bot,
      ),
    ).toEqual(bot);
  });

  it("follows the bot when a routine run only recorded the model an attempt used", () => {
    expect(runModelChoice({ modelPinned: false, ...routine }, bot)).toEqual(bot);
  });

  it("ignores run model columns that belong to an ordinary run", () => {
    // Ordinary runs record the model they used; that record is not an override.
    expect(runModelChoice(routine, bot)).toEqual(bot);
  });

  it("pins an inbound delivery only when every routine chose the same model", () => {
    expect(inboundRoutineModelPin([routine, routine])).toEqual({
      ...routine,
      modelPinned: true,
    });
    expect(
      inboundRoutineModelPin([
        routine,
        { modelProvider: null, modelId: null, thinkingLevel: null },
      ]),
    ).toEqual({});
    expect(
      inboundRoutineModelPin([
        routine,
        { modelProvider: "other", modelId: "other-model", thinkingLevel: null },
      ]),
    ).toEqual({});
  });

  it("leaves openai-compatible ids that differ from the default to the run path", () => {
    expect(
      pinnedModelCredentialError(
        { modelProvider: "openai-compatible", modelId: "listed-model", thinkingLevel: null },
        { defaultModel: "default-model" },
      ),
    ).toBeUndefined();
    expect(
      pinnedModelCredentialError(
        { modelProvider: "openai-compatible", modelId: "listed-model", thinkingLevel: null },
        null,
      ),
    ).toBe("Connect that model provider first");
  });

  it("rejects a pinned model whose credential is missing or belongs to another free-form model", () => {
    expect(pinnedModelCredentialError(routine, null)).toBe("Connect that model provider first");
    expect(pinnedModelCredentialError(routine, { defaultModel: "other-model" })).toBe(
      "Unknown model for that provider",
    );
    expect(pinnedModelCredentialError(routine, { defaultModel: routine.modelId })).toBeUndefined();
    expect(
      pinnedModelCredentialError(
        { modelProvider: "xai", modelId: "grok-4.6", thinkingLevel: null },
        { defaultModel: "other-model" },
      ),
    ).toBeUndefined();
  });
});

describe("defaultCatalogModelId", () => {
  it("skips Codex Spark as the default for ChatGPT subscription credentials", () => {
    const oauth = JSON.stringify({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
    });
    expect(defaultCatalogModelId("openai-codex", oauth)).not.toBe("gpt-5.3-codex-spark");
    expect(defaultCatalogModelId("openai-codex", oauth)).toBeTruthy();
  });
});

describe("space catalog auth", () => {
  const scope = { userId: "user-1", spaceId: "space-1" };
  const oauth = JSON.stringify({
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60_000,
  });
  const apiKey = "sk-test-api-key-12345678";
  const spark = "gpt-5.3-codex-spark";
  const luna = "gpt-6-luna";

  function stamp(iso: string) {
    return new Date(iso);
  }

  function storedCredential(id: string, secretId: string, iso: string) {
    return {
      id,
      provider: "openai-codex",
      secretId,
      updatedAt: stamp(iso),
      createdAt: stamp(iso),
    };
  }

  function storedPreference(input: {
    id: string;
    modelId: string | null;
    credentialId: string;
    secretId: string;
    iso: string;
  }) {
    return {
      id: input.id,
      modelId: input.modelId,
      updatedAt: stamp(input.iso),
      credential: storedCredential(input.credentialId, input.secretId, input.iso),
    };
  }

  function authPrisma(options: {
    credentials: ReturnType<typeof storedCredential>[];
    preferences: ReturnType<typeof storedPreference>[];
    secrets: Array<{ id: string; ciphertext: string }>;
  }) {
    const credentialFindMany = vi.fn().mockResolvedValue(options.credentials);
    const preferenceFindMany = vi.fn().mockResolvedValue(options.preferences);
    const secretFindMany = vi.fn().mockResolvedValue(options.secrets);
    const prisma = {
      userModelCredential: {
        findMany: credentialFindMany,
        findFirst: vi.fn().mockResolvedValue(null),
      },
      userModelPreference: { findMany: preferenceFindMany },
      secret: { findMany: secretFindMany },
    } as unknown as PrismaClient;
    return { prisma, credentialFindMany, preferenceFindMany, secretFindMany };
  }

  function listsSpark(auth: Awaited<ReturnType<typeof modelCredentialAuthKindsForSpace>>) {
    return listAvailablePiCatalog(auth.byProvider, auth.byModel).some(
      (entry) => entry.provider === "openai-codex" && entry.id === spark,
    );
  }

  it.each(["credits", "byok"])("keeps saved keys while selecting %s funding", async (mode) => {
    vi.stubEnv("PI_DEFAULT_PROVIDER", "openrouter");
    vi.stubEnv("OPENROUTER_API_KEY", "fixture-deployment-key");
    try {
      const { prisma } = authPrisma({
        credentials: [
          {
            ...storedCredential("personal", "personal-secret", "2026-01-01T00:00:00.000Z"),
            provider: "openrouter",
          },
        ],
        preferences: [],
        secrets: [{ id: "personal-secret", ciphertext: "fixture-ciphertext" }],
      });
      // Funding never replaces a key the member connected.
      Object.assign(prisma.userModelCredential, {
        findFirst: vi.fn().mockResolvedValue({ id: "personal" }),
      });
      Object.assign(prisma, {
        space: {
          findFirst: vi
            .fn()
            .mockResolvedValue({ organization: { modelCredits: { mode, balanceMicros: 1n } } }),
        },
      });
      const load = vi.fn().mockResolvedValue("fixture-personal-key");
      const auth = await modelCredentialAuthKindsForSpace(prisma, { load }, scope, "openrouter");
      expect(auth.byProvider.openrouter).toBe("api_key");
      expect(auth.managedProvider).toBeUndefined();
      expect(auth.secretIdByProvider?.openrouter).toBe("personal-secret");
      expect(load).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("retains hosted catalog access alongside a saved personal connection", async () => {
    vi.stubEnv("PI_DEFAULT_PROVIDER", "openrouter");
    vi.stubEnv("OPENROUTER_API_KEY", "fixture-deployment-key");
    try {
      const { prisma } = authPrisma({
        credentials: [storedCredential("cred-oauth", "secret-oauth", "2026-01-01T00:00:00.000Z")],
        preferences: [],
        secrets: [{ id: "secret-oauth", ciphertext: "cipher-oauth" }],
      });
      Object.assign(prisma, {
        space: {
          findFirst: vi
            .fn()
            .mockResolvedValue({ organization: { modelCredits: { mode: "credits" } } }),
        },
      });
      const auth = await modelCredentialAuthKindsForSpace(
        prisma,
        { load: vi.fn().mockResolvedValue(oauth) },
        scope,
        "openrouter",
      );
      expect(auth.managedProvider).toBe("openrouter");
      expect(auth.byProvider.openrouter).toBe("api_key");
      expect(auth.byProvider["openai-codex"]).toBe("oauth");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("uses the saved preference instead of a newer account credential", async () => {
    const { prisma, preferenceFindMany } = authPrisma({
      credentials: [
        storedCredential("cred-api", "secret-api", "2026-03-01T00:00:00.000Z"),
        storedCredential("cred-oauth", "secret-oauth", "2026-01-01T00:00:00.000Z"),
      ],
      preferences: [
        storedPreference({
          id: "pref-oauth",
          modelId: luna,
          credentialId: "cred-oauth",
          secretId: "secret-oauth",
          iso: "2026-01-02T00:00:00.000Z",
        }),
      ],
      secrets: [{ id: "secret-oauth", ciphertext: "cipher-oauth" }],
    });
    const load = vi.fn(async (ciphertext: string) =>
      ciphertext === "cipher-oauth" ? oauth : apiKey,
    );

    const auth = await modelCredentialAuthKindsForSpace(prisma, { load }, scope);

    expect(auth.byProvider["openai-codex"]).toBe("oauth");
    expect(preferenceFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: scope.userId },
      }),
    );
    expect(listsSpark(auth)).toBe(false);
    expect(load).not.toHaveBeenCalledWith("cipher-api", "secret-api");
  });

  it("keeps a model's API-key preference when the default is ChatGPT sign-in", async () => {
    const { prisma } = authPrisma({
      credentials: [
        storedCredential("cred-api", "secret-api", "2026-02-01T00:00:00.000Z"),
        storedCredential("cred-oauth", "secret-oauth", "2026-03-01T00:00:00.000Z"),
      ],
      preferences: [
        storedPreference({
          id: "pref-oauth",
          modelId: luna,
          credentialId: "cred-oauth",
          secretId: "secret-oauth",
          iso: "2026-03-02T00:00:00.000Z",
        }),
        storedPreference({
          id: "pref-spark",
          modelId: spark,
          credentialId: "cred-api",
          secretId: "secret-api",
          iso: "2026-02-02T00:00:00.000Z",
        }),
      ],
      secrets: [
        { id: "secret-oauth", ciphertext: "cipher-oauth" },
        { id: "secret-api", ciphertext: "cipher-api" },
      ],
    });
    const load = vi.fn(async (_ciphertext: string, secretId: unknown) =>
      secretId === "secret-oauth" ? oauth : apiKey,
    );

    const auth = await modelCredentialAuthKindsForSpace(prisma, { load }, scope);

    expect(auth.byModel["openai-codex"]?.[spark]).toBe("api_key");
    expect(auth.byProvider["openai-codex"]).toBe("oauth");
    expect(auth.secretIdByModel["openai-codex"]?.[spark]).toBe("secret-api");
    expect(auth.secretIdByProvider["openai-codex"]).toBe("secret-oauth");
    // Pi no longer bundles Spark for Codex; an API key reaches it on the openai provider.
    expect(listsSpark(auth)).toBe(false);
    expect(
      listAvailablePiCatalog(auth.byProvider, auth.byModel).some(
        (entry) => entry.provider === "openai-codex" && entry.id === luna,
      ),
    ).toBe(true);
  });

  it("hides Spark when the preference that owns it is ChatGPT sign-in", async () => {
    const { prisma } = authPrisma({
      credentials: [
        storedCredential("cred-api", "secret-api", "2026-03-01T00:00:00.000Z"),
        storedCredential("cred-oauth", "secret-oauth", "2026-01-01T00:00:00.000Z"),
      ],
      preferences: [
        storedPreference({
          id: "pref-api",
          modelId: luna,
          credentialId: "cred-api",
          secretId: "secret-api",
          iso: "2026-03-02T00:00:00.000Z",
        }),
        storedPreference({
          id: "pref-spark",
          modelId: spark,
          credentialId: "cred-oauth",
          secretId: "secret-oauth",
          iso: "2026-02-02T00:00:00.000Z",
        }),
      ],
      secrets: [
        { id: "secret-api", ciphertext: "cipher-api" },
        { id: "secret-oauth", ciphertext: "cipher-oauth" },
      ],
    });

    const auth = await modelCredentialAuthKindsForSpace(
      prisma,
      {
        load: async (_ciphertext: string, secretId: unknown) =>
          secretId === "secret-oauth" ? oauth : apiKey,
      },
      scope,
    );

    expect(auth.byModel["openai-codex"]?.[spark]).toBe("oauth");
    expect(auth.secretIdByModel["openai-codex"]?.[spark]).toBe("secret-oauth");
    expect(auth.secretIdByProvider["openai-codex"]).toBe("secret-api");
    expect(listsSpark(auth)).toBe(false);
  });

  it("does not replace an unreadable newest credential with an older API key", async () => {
    const { prisma, secretFindMany } = authPrisma({
      credentials: [
        storedCredential("cred-older", "secret-api", "2026-01-01T00:00:00.000Z"),
        storedCredential("cred-newest", "secret-broken", "2026-03-01T00:00:00.000Z"),
      ],
      preferences: [],
      secrets: [
        { id: "secret-broken", ciphertext: "cipher-broken" },
        { id: "secret-api", ciphertext: "cipher-api" },
      ],
    });
    const load = vi.fn(async (ciphertext: string) => {
      if (ciphertext === "cipher-broken") throw new Error("unreadable");
      return apiKey;
    });

    const auth = await modelCredentialAuthKindsForSpace(prisma, { load }, scope);

    expect(secretFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ["secret-broken"] } }),
      }),
    );
    expect(auth.byProvider).toEqual({});
    expect(auth.byModel).toEqual({});
    expect(listsSpark(auth)).toBe(false);
    expect(load).not.toHaveBeenCalledWith("cipher-api", "secret-api");
  });

  it("does not replace an unreadable model preference with the provider default", async () => {
    const { prisma } = authPrisma({
      credentials: [
        storedCredential("cred-api", "secret-api", "2026-03-01T00:00:00.000Z"),
        storedCredential("cred-oauth", "secret-oauth", "2026-01-01T00:00:00.000Z"),
      ],
      preferences: [
        storedPreference({
          id: "pref-api",
          modelId: luna,
          credentialId: "cred-api",
          secretId: "secret-api",
          iso: "2026-03-02T00:00:00.000Z",
        }),
        storedPreference({
          id: "pref-spark",
          modelId: spark,
          credentialId: "cred-oauth",
          secretId: "secret-oauth",
          iso: "2026-02-02T00:00:00.000Z",
        }),
      ],
      secrets: [
        { id: "secret-api", ciphertext: "cipher-api" },
        { id: "secret-oauth", ciphertext: "cipher-oauth" },
      ],
    });
    const load = vi.fn(async (_ciphertext: string, secretId: unknown) => {
      if (secretId === "secret-oauth") throw new Error("unreadable");
      return apiKey;
    });

    const auth = await modelCredentialAuthKindsForSpace(prisma, { load }, scope);

    expect(auth.byModel["openai-codex"]?.[spark]).toBe("disconnected");
    expect(listsSpark(auth)).toBe(false);
  });

  it("decrypts a provider credential once, not once per catalog model", async () => {
    const { prisma } = authPrisma({
      credentials: [
        {
          ...storedCredential("cred-or", "secret-or", "2026-03-01T00:00:00.000Z"),
          provider: "openrouter",
        },
      ],
      preferences: [],
      secrets: [{ id: "secret-or", ciphertext: "cipher-or" }],
    });
    const load = vi.fn(async () => apiKey);

    const auth = await modelCredentialAuthKindsForSpace(prisma, { load }, scope);

    expect(auth.byProvider.openrouter).toBe("api_key");
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("default credential selection", () => {
  const spark = "gpt-5.3-codex-spark";
  const luna = "gpt-6-luna";

  it("keeps the space preference when another account is also ready", () => {
    expect(
      selectDefaultCredentialId({
        provider: "openai-codex",
        modelId: luna,
        orderedIds: ["older", "newer"],
        readyIds: ["older", "newer"],
        savedModelId: (id) => (id === "older" ? "gpt-5.4" : null),
      }),
    ).toBe("older");
  });

  it("treats Spark as unrestricted now that Pi no longer bundles it for Codex", () => {
    expect(
      selectDefaultCredentialId({
        provider: "openai-codex",
        modelId: luna,
        orderedIds: ["api", "oauth"],
        readyIds: ["api", "oauth"],
        savedModelId: (id) => (id === "api" ? spark : null),
      }),
    ).toBe("api");
  });

  it("keeps the restricted binding when no other credential is ready", () => {
    expect(
      selectDefaultCredentialId({
        provider: "openai-codex",
        modelId: luna,
        orderedIds: ["api", "oauth"],
        readyIds: ["api"],
        savedModelId: (id) => (id === "api" ? spark : null),
      }),
    ).toBe("api");
  });
});

describe("stored model auth", () => {
  const userId = "user-1";

  it("rejects an unreadable secret and a model the credential cannot call", async () => {
    const findFirst = vi.fn(async (args: { where: { id?: string } }) => {
      if (args.where.id === "secret-broken") {
        return { id: "secret-broken", ciphertext: "cipher-broken" };
      }
      if (args.where.id === "secret-oauth") {
        return { id: "secret-oauth", ciphertext: "cipher-oauth" };
      }
      return null;
    });
    const prisma = { secret: { findFirst } } as unknown as PrismaClient;
    const load = vi.fn(async (ciphertext: string) => {
      if (ciphertext === "cipher-broken") throw new Error("unreadable");
      return JSON.stringify({
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
      });
    });

    await expect(
      readStoredModelAuth(prisma, { load }, userId, "secret-missing", "openai-codex", "gpt-6-luna"),
    ).resolves.toEqual({ status: "unreadable" });
    await expect(
      readStoredModelAuth(prisma, { load }, userId, "secret-broken", "openai-codex", "gpt-6-luna"),
    ).resolves.toEqual({ status: "unreadable" });
    await expect(
      readStoredModelAuth(
        prisma,
        { load },
        userId,
        "secret-oauth",
        "openai-codex",
        "gpt-5.3-codex-spark",
      ),
    ).resolves.toEqual({
      status: "rejected",
      message: expect.stringMatching(/not available with your current sign-in/i),
    });
    await expect(
      readStoredModelAuth(prisma, { load }, userId, "secret-oauth", "openai-codex", "gpt-6-luna"),
    ).resolves.toEqual({ status: "ready" });
  });

  it("keeps a decryptable-but-corrupt secret unreadable even when the live catalog lists the model", async () => {
    const prisma = {
      secret: {
        findFirst: vi.fn(async () => ({
          id: "secret-corrupt",
          ciphertext: "cipher-corrupt",
        })),
      },
    } as unknown as PrismaClient;
    // Decrypts fine, but the stored JSON claims oauth without a credential.
    const load = vi.fn(async () => JSON.stringify({ kind: "oauth" }));
    const live = {
      read: vi.fn(async () => [
        {
          slug: "gpt-5.3-codex-spark",
          reasoningEfforts: [],
          supportsImages: false,
          supportsFastTier: true,
        },
      ]),
    };

    await expect(
      readStoredModelAuth(
        prisma,
        { load },
        userId,
        "secret-corrupt",
        "openai-codex",
        "gpt-5.3-codex-spark",
        live,
      ),
    ).resolves.toEqual({ status: "unreadable" });
    expect(live.read).not.toHaveBeenCalled();
  });

  it("accepts a statically excluded model when its own account's live catalog lists it", async () => {
    const prisma = {
      secret: {
        findFirst: vi.fn(async () => ({
          id: "secret-oauth",
          ciphertext: "cipher-oauth",
        })),
      },
    } as unknown as PrismaClient;
    const oauthWithAccount = JSON.stringify({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
      accountId: "acct-live",
    });
    const load = vi.fn(async () => oauthWithAccount);
    const live = {
      read: vi.fn(async (_userId: string, account: { accountId: string }) =>
        account.accountId === "acct-live"
          ? [
              {
                slug: "gpt-5.3-codex-spark",
                reasoningEfforts: [],
                supportsImages: false,
                supportsFastTier: true,
              },
            ]
          : undefined,
      ),
    };

    await expect(
      readStoredModelAuth(
        prisma,
        { load },
        userId,
        "secret-oauth",
        "openai-codex",
        "gpt-5.3-codex-spark",
        live,
      ),
    ).resolves.toEqual({ status: "ready" });
    expect(live.read).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({ accountId: "acct-live" }),
      undefined,
    );

    // A catalog that does not list the model keeps the static rejection.
    await expect(
      readStoredModelAuth(
        prisma,
        { load },
        userId,
        "secret-oauth",
        "openai-codex",
        "gpt-5.3-codex-spark",
        { read: vi.fn(async () => []) },
      ),
    ).resolves.toEqual({
      status: "rejected",
      message: expect.stringMatching(/not available with your current sign-in/i),
    });
  });

  it("does not consult the live catalog for an expired credential", async () => {
    const prisma = {
      secret: {
        findFirst: vi.fn(async () => ({
          id: "secret-oauth",
          ciphertext: "cipher-oauth",
        })),
      },
    } as unknown as PrismaClient;
    const load = vi.fn(async () =>
      JSON.stringify({
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() - 1_000,
        accountId: "acct-live",
      }),
    );
    const read = vi.fn(
      async (
        _userId: string,
        account: { accountId: string; accessToken: () => Promise<string | null> },
      ) => {
        // The catalog path must see an expired credential as "no usable token".
        return (await account.accessToken()) === null ? undefined : [];
      },
    );

    await expect(
      readStoredModelAuth(
        prisma,
        { load },
        userId,
        "secret-oauth",
        "openai-codex",
        "gpt-5.3-codex-spark",
        { read },
      ),
    ).resolves.toEqual({
      status: "rejected",
      message: expect.stringMatching(/not available with your current sign-in/i),
    });
  });

  it("fires the expired-token hook so the caller can kick a detached refresh", async () => {
    const prisma = {
      secret: {
        findFirst: vi.fn(async () => ({
          id: "secret-oauth",
          ciphertext: "cipher-oauth",
        })),
      },
    } as unknown as PrismaClient;
    let plaintext = JSON.stringify({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() - 1_000,
      accountId: "acct-live",
    });
    const load = vi.fn(async () => plaintext);
    const read = vi.fn(
      async (
        _userId: string,
        account: { accountId: string; accessToken: () => Promise<string | null> },
      ) =>
        (await account.accessToken()) === null
          ? undefined
          : [
              {
                slug: "gpt-5.3-codex-spark",
                reasoningEfforts: [],
                supportsImages: false,
                supportsFastTier: true,
              },
            ],
    );
    const onExpiredToken = vi.fn();

    await expect(
      readStoredModelAuth(
        prisma,
        { load },
        userId,
        "secret-oauth",
        "openai-codex",
        "gpt-5.3-codex-spark",
        { read },
        { onExpiredToken },
      ),
    ).resolves.toEqual({
      status: "rejected",
      message: expect.stringMatching(/not available with your current sign-in/i),
    });
    expect(onExpiredToken).toHaveBeenCalledTimes(1);

    // A valid bearer never fires the hook — and the live answer flows through.
    plaintext = JSON.stringify({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
      accountId: "acct-live",
    });
    await expect(
      readStoredModelAuth(
        prisma,
        { load },
        userId,
        "secret-oauth",
        "openai-codex",
        "gpt-5.3-codex-spark",
        { read },
        { onExpiredToken },
      ),
    ).resolves.toEqual({ status: "ready" });
    expect(onExpiredToken).toHaveBeenCalledTimes(1);
  });

  it("passes a zero wait bound through to the catalog read", async () => {
    const prisma = {
      secret: {
        findFirst: vi.fn(async () => ({
          id: "secret-oauth",
          ciphertext: "cipher-oauth",
        })),
      },
    } as unknown as PrismaClient;
    const load = vi.fn(async () =>
      JSON.stringify({
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
        accountId: "acct-live",
      }),
    );
    const read = vi.fn(async () => [
      {
        slug: "gpt-5.3-codex-spark",
        reasoningEfforts: [],
        supportsImages: false,
        supportsFastTier: true,
      },
    ]);

    await expect(
      readStoredModelAuth(
        prisma,
        { load },
        userId,
        "secret-oauth",
        "openai-codex",
        "gpt-5.3-codex-spark",
        { read },
        { waitMs: 0 },
      ),
    ).resolves.toEqual({ status: "ready" });
    expect(read).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({ accountId: "acct-live" }),
      expect.objectContaining({ waitMs: 0 }),
    );
  });
});

describe("model auth availability", () => {
  it("rejects Codex Spark for oauth credentials and keeps other catalog models", () => {
    const oauth = JSON.stringify({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
    });
    expect(validateModelAuthAvailability("openai-codex", "gpt-5.3-codex-spark", oauth)).toMatch(
      /not available with your current sign-in/i,
    );
    expect(validateModelAuthAvailability("openai-codex", "gpt-6-luna", oauth)).toBeUndefined();
    expect(
      validateModelAuthAvailability("openai-codex", "gpt-5.3-codex-spark", "sk-test-api-key"),
    ).toBeUndefined();
  });
});

describe("connected model credential selection", () => {
  it("routes legacy pins and new choices to enabled connections without storing choices", async () => {
    const selected = credential("openai-compatible", "X");
    const alternate = { ...selected, id: "alternate", secretId: "secret-alternate" };
    const secrets: Record<string, string> = {
      [selected.secretId]: JSON.stringify({
        kind: "openai_compatible",
        baseUrl: "https://legacy.example/v1",
      }),
      [alternate.secretId]: JSON.stringify({
        kind: "openai_compatible",
        baseUrl: "https://alternate.example/v1",
        enabledModelIds: ["Y", "Z"],
        reasoning: true,
      }),
    };
    const preferences = [
      {
        id: "preference",
        credential: selected,
        modelId: "X",
        thinkingLevel: null,
        updatedAt: new Date(0),
      },
    ];
    const prisma = {
      userModelPreference: {
        findMany: vi.fn(async () => preferences),
        findFirst: vi.fn(
          async ({ where }: { where: { modelId: string } }) =>
            preferences.find((preference) => preference.modelId === where.modelId) ?? null,
        ),
        upsert: vi.fn(),
      },
      userModelCredential: { findMany: vi.fn(async () => [alternate, selected]) },
      secret: {
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({
          id: where.id,
          ciphertext: secrets[where.id],
        })),
      },
    };
    const load = vi.fn(async (plaintext: string) => plaintext);

    const db = prisma as unknown as PrismaClient;
    const actor = { userId: "user-1", spaceId: "space-1" };
    const clients = [
      { ...alternate, label: "B", modelId: null, enabledModelIds: ["Y", "Z"] },
      { ...selected, label: "A", modelId: "X", isDefault: true },
    ];
    for (const model of ["Y", "Z", "Y"]) {
      await expect(
        validateBotModelChange(
          {
            prisma: db,
            secretStore: { load },
            refreshExpiredCredential: vi.fn(),
            defaultModel: async () => ({ provider: null, model: null }),
          },
          {
            ...actor,
            provider: "openai-compatible",
            model,
            thinkingLevel: "high",
            current: { provider: "openai-compatible", model: "X" },
          },
        ),
      ).resolves.toMatchObject({ ok: true });
      const resolved = await findConnectedModelCredential(
        db,
        { load },
        actor,
        "openai-compatible",
        model,
      );
      expect(resolved?.id).toBe(alternate.id);
      expect(credentialForModel(clients, "openai-compatible", model)?.id).toBe(resolved?.id);
      await expect(
        prepareAllowedThinkingLevels(
          { prisma: db, secretStore: { load } },
          actor,
          "openai-compatible",
          model,
        ),
      ).resolves.toMatchObject({ allowed: expect.arrayContaining(["high"]) });
    }
    expect(prisma.userModelPreference.upsert).not.toHaveBeenCalled();
    expect(preferences).toHaveLength(1);
    expect(preferences[0]).toMatchObject({ modelId: "X" });
  });
});

describe("connected model validation", () => {
  const actor: Pick<Actor, "userId" | "spaceId"> = {
    userId: "user-1",
    spaceId: "space-1",
  };
  const noStore = {
    load: async (): Promise<string> => {
      throw new Error("no secret expected");
    },
  };

  it("accepts catalog and saved free-form models but rejects unavailable choices", async () => {
    const catalogPrisma = {
      secret: { findFirst: async () => null },
      userModelPreference: { findFirst: async () => null },
      userModelCredential: {
        findMany: vi.fn(async () => []),
        findFirst: async () => credential("xai", null),
      },
    } as unknown as PrismaClient;
    await expect(
      validateConnectedModelChoice(catalogPrisma, noStore, actor, "xai", "grok-4.6"),
    ).resolves.toBeUndefined();
    await expect(
      validateConnectedModelChoice(catalogPrisma, noStore, actor, "xai", "not-a-model"),
    ).resolves.toBe("Unknown model for that provider");

    const preferenceFindFirst = vi.fn(
      async (args: {
        where: {
          spaceId?: string;
          userId?: string;
          modelId?: string;
          credential?: { provider?: string; userId?: string };
        };
      }) => {
        if (args.where.modelId) {
          if (
            args.where.userId === actor.userId &&
            args.where.modelId === "private-model" &&
            args.where.credential?.provider === "openai-compatible" &&
            args.where.credential?.userId === actor.userId
          ) {
            return { credentialId: "saved-private-model" };
          }
          return null;
        }
        if (args.where.credential?.provider === "openai-compatible") {
          return {
            credential: credential("openai-compatible", "newest-model"),
            modelId: "newest-model",
            thinkingLevel: null,
          };
        }
        return null;
      },
    );
    const customPrisma = {
      userModelPreference: { findFirst: preferenceFindFirst },
      userModelCredential: { findMany: vi.fn(async () => []), findFirst: async () => null },
      secret: { findFirst: async () => null },
    } as unknown as PrismaClient;
    await expect(
      validateConnectedModelChoice(
        customPrisma,
        noStore,
        actor,
        "openai-compatible",
        "private-model",
      ),
    ).resolves.toBeUndefined();
    expect(preferenceFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: actor.userId,
          modelId: "private-model",
          credential: { userId: actor.userId, provider: "openai-compatible" },
        }),
        select: { credentialId: true },
      }),
    );
    await expect(
      validateConnectedModelChoice(
        customPrisma,
        noStore,
        actor,
        "openai-compatible",
        "missing-model",
      ),
    ).resolves.toBe("Unknown model for that provider");

    const disconnectedPrisma = {
      userModelPreference: { findFirst: async () => null },
      userModelCredential: { findMany: vi.fn(async () => []), findFirst: async () => null },
    } as unknown as PrismaClient;
    await expect(
      validateConnectedModelChoice(
        disconnectedPrisma,
        noStore,
        actor,
        "anthropic",
        "claude-opus-4-6",
      ),
    ).resolves.toBe("Connect that model provider first");

    await expect(
      validateConnectedModelChoice(catalogPrisma, noStore, actor, "xai", "null"),
    ).resolves.toBe("Unknown model for that provider");
    await expect(
      validateConnectedModelChoice(catalogPrisma, noStore, actor, "xai", "undefined"),
    ).resolves.toBe("Unknown model for that provider");
  });
});

describe("enabled openai-compatible models", () => {
  const actor: Pick<Actor, "userId" | "spaceId"> = { userId: "user-1", spaceId: "space-1" };
  const baseUrl = "http://127.0.0.1:8000/v1";

  it("returns the default first, then the stored list, trimmed and unique", () => {
    expect(enabledOpenAiCompatibleModelIds({ kind: "openai_compatible", baseUrl }, "x")).toEqual([
      "x",
    ]);
    expect(
      enabledOpenAiCompatibleModelIds(
        { kind: "openai_compatible", baseUrl, enabledModelIds: [" a ", "x", "", "a", "b"] },
        " x ",
      ),
    ).toEqual(["x", "a", "b"]);
    expect(
      enabledOpenAiCompatibleModelIds(
        { kind: "openai_compatible", baseUrl, enabledModelIds: ["X"] },
        "Y",
      ),
    ).toEqual(["Y", "X"]);
    expect(enabledOpenAiCompatibleModelIds(undefined, null)).toEqual([]);
    expect(enabledOpenAiCompatibleModelIds({ kind: "api_key", key: "k" }, "x")).toEqual(["x"]);
  });

  function compatiblePrisma(defaultModel: string, ciphertext: string | null) {
    return {
      userModelPreference: {
        findFirst: async (args: { where: { modelId?: string }; select?: unknown }) => {
          if (args.where.modelId !== undefined && args.select) {
            return args.where.modelId === defaultModel ? { id: "preference" } : null;
          }
          return {
            credential: credential("openai-compatible", defaultModel),
            modelId: defaultModel,
            thinkingLevel: null,
          };
        },
      },
      userModelCredential: { findMany: vi.fn(async () => []), findFirst: async () => null },
      secret: {
        findFirst: vi.fn(async () =>
          ciphertext === null ? null : { id: "secret-openai-compatible", ciphertext },
        ),
      },
    } as unknown as PrismaClient;
  }
  const store = {
    load: async (ciphertext: string) => {
      if (ciphertext === "broken") throw new Error("cannot decrypt");
      if (ciphertext === "down") throw new SecretStoreUnavailableError();
      return ciphertext;
    },
  };
  const legacy = JSON.stringify({ kind: "openai_compatible", baseUrl });
  const listed = JSON.stringify({ kind: "openai_compatible", baseUrl, enabledModelIds: ["X"] });
  const validate = (prisma: PrismaClient, modelId: string) =>
    validateConnectedModelChoice(prisma, store, actor, "openai-compatible", modelId);

  it("accepts an id from the stored list that no preference names", async () => {
    await expect(validate(compatiblePrisma("Y", listed), "X")).resolves.toBeUndefined();
  });

  it("accepts the space default beside a stored list that omits it", async () => {
    await expect(validate(compatiblePrisma("Y", listed), "Y")).resolves.toBeUndefined();
  });

  it("accepts non-default ids on a legacy secret when no connection enables them", async () => {
    await expect(validate(compatiblePrisma("Y", legacy), "Y")).resolves.toBeUndefined();
    await expect(validate(compatiblePrisma("Y", legacy), "X")).resolves.toBeUndefined();
  });

  it("fails closed when the secret is missing or unreadable", async () => {
    await expect(validate(compatiblePrisma("Y", null), "X")).resolves.toBe(
      "Unknown model for that provider",
    );
    await expect(validate(compatiblePrisma("Y", "broken"), "X")).resolves.toBe(
      "Unknown model for that provider",
    );
    await expect(validate(compatiblePrisma("Y", "{not json"), "X")).resolves.toBe(
      "Unknown model for that provider",
    );
  });

  it("enforces enabled ids even for the catalog placeholder, with legacy compatibility", async () => {
    await expect(validate(compatiblePrisma("Y", listed), "custom")).resolves.toBe(
      "Unknown model for that provider",
    );
    await expect(validate(compatiblePrisma("Y", legacy), "custom")).resolves.toBeUndefined();
  });

  it("propagates an unavailable secret store", async () => {
    await expect(validate(compatiblePrisma("Y", "down"), "X")).rejects.toBeInstanceOf(
      SecretStoreUnavailableError,
    );
  });
});

describe("loadStoredModelSecret", () => {
  const prisma = {
    secret: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === "missing" ? null : { id: where.id, ciphertext: `cipher-${where.id}` },
      ),
    },
  };
  const store = {
    load: vi.fn(async (ciphertext: string) => {
      if (ciphertext === "cipher-down") throw new SecretStoreUnavailableError();
      if (ciphertext === "cipher-corrupt") throw new Error("bad ciphertext");
      return "fake-plaintext";
    }),
  };
  const load = (secretId: string) =>
    loadStoredModelSecret(prisma as never, store, "user-1", secretId);

  it("reports missing, unreadable and loaded secrets with the ciphertext ref", async () => {
    await expect(load("missing")).resolves.toEqual({ status: "missing" });
    await expect(load("corrupt")).resolves.toEqual({
      status: "unreadable",
      ciphertext: "cipher-corrupt",
    });
    await expect(load("ok")).resolves.toEqual({
      status: "loaded",
      ciphertext: "cipher-ok",
      plaintext: "fake-plaintext",
    });
    expect(prisma.secret.findFirst).toHaveBeenCalledWith({
      where: { id: "ok", userId: "user-1", spaceId: null },
      select: { id: true, ciphertext: true },
    });
  });

  it("propagates a secret store outage", async () => {
    await expect(load("down")).rejects.toBeInstanceOf(SecretStoreUnavailableError);
  });
});

describe("bot model change validation", () => {
  const scope = { userId: "user-1", spaceId: "space-1" };
  const oauthSecret = JSON.stringify({
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60_000,
  });

  function changeDeps(connected: Record<string, ReturnType<typeof credential>>) {
    const prisma = {
      // A saved model lives on the space preference, as the picker writes it.
      userModelPreference: {
        findFirst: async (args: { where: { credential?: { provider?: string } } }) => {
          const saved = connected[args.where.credential?.provider ?? ""];
          if (!saved?.defaultModel) return null;
          return {
            credential: saved,
            modelId: saved.defaultModel,
            thinkingLevel: null,
          };
        },
      },
      userModelCredential: {
        findFirst: async (args: { where: { provider?: string } }) =>
          connected[args.where.provider ?? ""] ?? null,
      },
      secret: {
        findFirst: async (args: { where: { id?: string } }) => ({
          id: args.where.id,
          ciphertext: `cipher-${args.where.id}`,
        }),
      },
    } as unknown as PrismaClient;
    return {
      prisma,
      secretStore: { load: async () => oauthSecret },
      refreshExpiredCredential: vi.fn(),
      defaultModel: async () => ({ provider: "xai", model: "grok-4.6" }),
    };
  }

  it("rejects a disconnected provider and an unknown model", async () => {
    const deps = changeDeps({ xai: credential("xai", "saved-model") });
    await expect(
      validateBotModelChange(deps, { ...scope, provider: "anthropic", model: "claude-opus-4-6" }),
    ).resolves.toEqual({ ok: false, error: "Connect that model provider first" });
    await expect(
      validateBotModelChange(deps, { ...scope, provider: "xai", model: "not-a-model" }),
    ).resolves.toEqual({ ok: false, error: "Unknown model for that provider" });
    await expect(
      validateBotModelChange(deps, { ...scope, provider: "xai", model: "saved-model" }),
    ).resolves.toEqual({ ok: true, provider: "xai", model: "saved-model", thinkingLevel: null });
  });

  it("rejects Spark on Codex, which Pi no longer bundles", async () => {
    const deps = changeDeps({ "openai-codex": credential("openai-codex", null) });
    const result = await validateBotModelChange(deps, {
      ...scope,
      provider: "openai-codex",
      model: "gpt-5.3-codex-spark",
    });
    expect(result).toEqual({ ok: false, error: "Unknown model for that provider" });
  });

  it("rejects a thinking level the model does not offer, including the default model", async () => {
    const deps = changeDeps({ xai: credential("xai", null) });
    const levels = listPiCatalog().find(
      (item) => item.provider === "xai" && item.id === "grok-4.6",
    )?.thinkingLevels;
    expect(levels).not.toContain("off");
    const error = `Thinking level must be one of: ${levels?.join(", ")}`;
    await expect(
      validateBotModelChange(deps, {
        ...scope,
        provider: "xai",
        model: "grok-4.6",
        thinkingLevel: "off",
      }),
    ).resolves.toEqual({ ok: false, error });
    await expect(
      validateBotModelChange(deps, { ...scope, provider: null, model: null, thinkingLevel: "off" }),
    ).resolves.toEqual({ ok: false, error });
    await expect(
      validateBotModelChange(deps, {
        ...scope,
        provider: "xai",
        model: "grok-4.6",
        thinkingLevel: "high",
      }),
    ).resolves.toEqual({ ok: true, provider: "xai", model: "grok-4.6", thinkingLevel: "high" });
  });

  it("uses canonical catalog thinking levels for a saved Azure provider alias", async () => {
    const entry = listPiCatalog().find(
      (item) => item.provider === "azure" && item.thinkingLevels?.length,
    );
    expect(entry).toBeDefined();
    const deps = changeDeps({});
    await expect(
      prepareAllowedThinkingLevels(deps, scope, "azure-openai-responses", entry!.id),
    ).resolves.toEqual({ allowed: entry!.thinkingLevels });
    await expect(
      validateBotModelChange(deps, {
        ...scope,
        provider: "azure-openai-responses",
        model: entry!.id,
        current: { provider: "azure-openai-responses", model: entry!.id },
        thinkingLevel: "unsupported",
      }),
    ).resolves.toEqual({
      ok: false,
      error: `Thinking level must be one of: ${entry!.thinkingLevels!.join(", ")}`,
    });
  });

  it("skips model checks when the model is unchanged", async () => {
    const deps = changeDeps({});
    await expect(
      validateBotModelChange(deps, {
        ...scope,
        provider: "xai",
        model: "retired-model",
        current: { provider: "xai", model: "retired-model" },
      }),
    ).resolves.toEqual({ ok: true, provider: "xai", model: "retired-model", thinkingLevel: null });
  });

  it("clears the model", async () => {
    await expect(
      validateBotModelChange(changeDeps({}), { ...scope, provider: null, model: null }),
    ).resolves.toEqual({ ok: true, provider: null, model: null, thinkingLevel: null });
  });
});

describe("live-only catalog validation", () => {
  it("uses the selected user's credential and shared cache for bot, routine, backup and run pins", async () => {
    const model = "gpt-future-live-chat";
    const selected = credential("openai", null);
    const savedBots = vi.fn(async () => [{ modelProvider: "openai", modelId: model }]);
    const prisma = {
      bot: { findMany: savedBots },
      routine: { findMany: async () => [] },
      spaceSettingOverride: { findUnique: vi.fn(async () => null) },
      userModelRoleChoice: { findMany: async () => [] },
      spaceModelRoleChoice: { findMany: async () => [] },
      deploymentSettings: { findFirst: async () => null },
      userModelPreference: { findFirst: async () => null, findMany: async () => [] },
      userModelCredential: { findMany: async () => [selected], findFirst: async () => selected },
      secret: {
        findFirst: vi.fn(async () => ({ id: selected.secretId, ciphertext: "fake-ciphertext" })),
      },
    } as unknown as PrismaClient;
    const secretStore = { load: vi.fn(async () => "fake-api-key") };
    const enabled = vi.spyOn(providerCatalogCache, "enabled", "get").mockReturnValue(true);
    const read = vi.spyOn(providerCatalogCache, "read").mockResolvedValue([model]);
    const actor = { userId: "user-1", spaceId: "space-1" };
    try {
      expect(
        await validateConnectedModelChoice(prisma, secretStore, actor, "openai", model),
      ).toBeUndefined();
      expect(
        await validateBotModelChange(
          {
            prisma,
            secretStore,
            refreshExpiredCredential: () => {},
            defaultModel: async () => ({ provider: null, model: null }),
          },
          { ...actor, provider: "openai", model },
        ),
      ).toMatchObject({ ok: true });
      expect(
        pinnedModelCredentialError(
          { modelProvider: "openai", modelId: model, thinkingLevel: null },
          selected,
        ),
      ).toBeUndefined();
      expect(read).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "openai",
          secretId: selected.secretId,
          version: expect.any(String),
        }),
      );
      expect(prisma.secret.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: selected.secretId, userId: actor.userId, spaceId: null },
        }),
      );
      read.mockResolvedValue(
        listPiCatalog()
          .filter((entry) => entry.provider === "openai")
          .map((entry) => entry.id),
      );
      expect(
        await validateConnectedModelChoice(prisma, secretStore, actor, "openai", model),
      ).toBeUndefined();
      savedBots.mockResolvedValue([]);
      expect(await validateConnectedModelChoice(prisma, secretStore, actor, "openai", model)).toBe(
        "Unknown model for that provider",
      );
      read.mockResolvedValue(undefined);
      expect(await validateConnectedModelChoice(prisma, secretStore, actor, "openai", model)).toBe(
        "Unknown model for that provider",
      );
    } finally {
      read.mockRestore();
      enabled.mockRestore();
    }
  });
});

describe("connectionServesModel", () => {
  const signedIn = (accountId: string) =>
    serializeModelSecret({
      kind: "oauth",
      credential: {
        type: "oauth",
        access: `fake.${Buffer.from(JSON.stringify({ chatgpt_account_id: accountId })).toString("base64url")}.fake`,
        refresh: "fake-refresh",
        expires: Date.now() + 60_000,
        accountId,
      },
    });
  const plaintexts: Record<string, string> = {
    "secret-pro": signedIn("acct-pro"),
    "secret-plus": signedIn("acct-plus"),
  };
  const deps = {
    prisma: {
      secret: {
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({
          id: where.id,
          ciphertext: where.id,
        })),
      },
    } as unknown as PrismaClient,
    secretStore: { load: vi.fn(async (ciphertext: string) => plaintexts[ciphertext]!) },
    codexCatalog: {
      read: vi.fn(async (_userId: string, account: { accountId: string }) =>
        account.accountId === "acct-pro"
          ? [
              {
                slug: "gpt-5.3-codex-spark",
                reasoningEfforts: [],
                supportsImages: false,
                supportsFastTier: false,
              },
            ]
          : [],
      ),
    } as unknown as CodexLiveCatalog,
  };

  it("offers a model only on the account whose own catalog lists it", async () => {
    const serves = (secretId: string, modelId: string) =>
      connectionServesModel(deps, "user-1", { secretId }, "openai-codex", modelId);
    await expect(serves("secret-pro", "gpt-5.3-codex-spark")).resolves.toBe(true);
    await expect(serves("secret-plus", "gpt-5.3-codex-spark")).resolves.toBe(false);
    // Models every account can call need no lookup.
    const shared = listPiCatalog().find(
      (entry) => entry.provider === "openai-codex" && entry.id !== "gpt-5.3-codex-spark",
    )!;
    deps.secretStore.load.mockClear();
    await expect(serves("secret-plus", shared.id)).resolves.toBe(true);
    expect(deps.secretStore.load).not.toHaveBeenCalled();
  });

  it("reads each account's secret once for every model one request checks", async () => {
    // Spark and models only an account's own catalog lists.
    const liveOnly = ["gpt-5.9-codex", "gpt-5.9-codex-mini", "gpt-6.0-codex"];
    for (const id of liveOnly) expect(liveCatalogEntry("openai-codex", id)).toBeDefined();
    const reads = new Map();
    const findFirst = vi.mocked(deps.prisma.secret.findFirst);
    findFirst.mockClear();
    deps.secretStore.load.mockClear();
    for (const secretId of ["secret-pro", "secret-plus"])
      for (const modelId of ["gpt-5.3-codex-spark", ...liveOnly])
        await connectionServesModel(
          { ...deps, reads },
          "user-1",
          { secretId },
          "openai-codex",
          modelId,
        );
    expect(findFirst).toHaveBeenCalledTimes(2);
    expect(deps.secretStore.load).toHaveBeenCalledTimes(2);
  });
});
