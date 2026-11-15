import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import {
  chooseModelCredential,
  defaultModelCredentialCandidates,
  findModelCredential,
  newestModelCredentialOrder,
  saveModelPreference,
} from "./model-credentials.js";

describe("findModelCredential", () => {
  it("falls back to the newest user credential when there is no preference", async () => {
    const preferenceFindFirst = vi.fn().mockResolvedValue(null);
    const credentialFindFirst = vi.fn().mockResolvedValue(null);
    const prisma = {
      userModelPreference: { findFirst: preferenceFindFirst },
      userModelCredential: { findFirst: credentialFindFirst },
    } as unknown as PrismaClient;

    await findModelCredential(prisma, { userId: "user" }, "xai");

    expect(preferenceFindFirst).toHaveBeenCalledWith({
      where: { userId: "user", credential: { provider: "xai" } },
      include: { credential: true },
      orderBy: [{ updatedAt: "desc" }, { credentialId: "desc" }],
    });
    expect(credentialFindFirst).toHaveBeenCalledWith({
      where: { userId: "user", provider: "xai" },
      orderBy: newestModelCredentialOrder,
    });
  });

  it("prefers the preference that owns a free-form modelId over the provider default", async () => {
    const matching = {
      credential: {
        id: "credential-other",
        userId: "user",
        provider: "openai-compatible",
        label: "Other",
        secretId: "secret-other",
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
      modelId: "other-model",
    };
    const preferenceFindFirst = vi.fn().mockResolvedValue(matching);
    const prisma = {
      userModelPreference: { findFirst: preferenceFindFirst },
      userModelCredential: { findFirst: vi.fn() },
    } as unknown as PrismaClient;

    await expect(
      findModelCredential(prisma, { userId: "user" }, "openai-compatible", "other-model"),
    ).resolves.toEqual({
      ...matching.credential,
      defaultModel: "other-model",
    });
    expect(preferenceFindFirst).toHaveBeenCalledWith({
      where: {
        userId: "user",
        modelId: "other-model",
        credential: { provider: "openai-compatible" },
      },
      include: { credential: true },
      orderBy: [{ updatedAt: "desc" }, { credentialId: "desc" }],
    });
    expect(preferenceFindFirst).toHaveBeenCalledTimes(1);
  });

  it("uses chooseModelCredential when the client can list every candidate", async () => {
    const older = {
      id: "credential-older",
      userId: "user",
      provider: "openai-codex",
      label: "Older",
      secretId: "secret-older",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    };
    const newer = {
      id: "credential-newer",
      userId: "user",
      provider: "openai-codex",
      label: "Newer",
      secretId: "secret-newer",
      createdAt: new Date("2026-02-01T00:00:00.000Z"),
      updatedAt: new Date("2026-02-02T00:00:00.000Z"),
    };
    const sparkPreference = {
      modelId: "gpt-5.3-codex-spark",
      thinkingLevel: null,
      updatedAt: new Date("2026-02-03T00:00:00.000Z"),
      credential: older,
    };
    const defaultPreference = {
      modelId: "gpt-6-luna",
      thinkingLevel: null,
      updatedAt: new Date("2026-03-01T00:00:00.000Z"),
      credential: newer,
    };
    const preferenceFindMany = vi.fn().mockResolvedValue([defaultPreference, sparkPreference]);
    const credentialFindMany = vi.fn().mockResolvedValue([older, newer]);
    const prisma = {
      userModelPreference: { findMany: preferenceFindMany },
      userModelCredential: { findMany: credentialFindMany },
    } as unknown as PrismaClient;

    await expect(
      findModelCredential(prisma, { userId: "user" }, "openai-codex", "gpt-5.3-codex-spark"),
    ).resolves.toEqual({
      ...older,
      defaultModel: "gpt-5.3-codex-spark",
      thinkingLevel: null,
    });
    await expect(
      findModelCredential(prisma, { userId: "user" }, "openai-codex", "gpt-6-luna"),
    ).resolves.toEqual({
      ...newer,
      defaultModel: "gpt-6-luna",
      thinkingLevel: null,
    });
  });
});

describe("chooseModelCredential", () => {
  function credential(id: string, iso: string) {
    const at = new Date(iso);
    return {
      id,
      provider: "openai-codex",
      secretId: `secret-${id}`,
      updatedAt: at,
      createdAt: at,
    };
  }

  it("prefers the preference that owns the model id over the default", () => {
    const apiKey = credential("api", "2026-01-01T00:00:00.000Z");
    const oauth = credential("oauth", "2026-03-01T00:00:00.000Z");
    const choice = chooseModelCredential({
      provider: "openai-codex",
      modelId: "gpt-5.3-codex-spark",
      preferences: [
        {
          modelId: "gpt-6-luna",
          thinkingLevel: null,
          updatedAt: new Date("2026-03-02T00:00:00.000Z"),
          credential: oauth,
        },
        {
          modelId: "gpt-5.3-codex-spark",
          thinkingLevel: null,
          updatedAt: new Date("2026-02-01T00:00:00.000Z"),
          credential: apiKey,
        },
      ],
      credentials: [oauth, apiKey],
    });
    expect(choice).toEqual({
      source: "preference",
      preference: expect.objectContaining({ credential: apiKey }),
    });
  });

  it("prefers the latest preference over a newer unused credential", () => {
    const older = credential("older", "2026-01-01T00:00:00.000Z");
    const newer = credential("newer", "2026-02-01T00:00:00.000Z");
    const candidates = defaultModelCredentialCandidates({
      provider: "openai-codex",
      modelId: "gpt-6-luna",
      preferences: [
        {
          modelId: "gpt-5.4",
          thinkingLevel: null,
          updatedAt: new Date("2026-01-02T00:00:00.000Z"),
          credential: older,
        },
      ],
      credentials: [newer, older],
    });
    expect(candidates.map((item) => item.id)).toEqual(["older", "newer"]);
  });

  it("keeps the model owner as the only default candidate", () => {
    const apiKey = credential("api", "2026-01-01T00:00:00.000Z");
    const oauth = credential("oauth", "2026-03-01T00:00:00.000Z");
    const candidates = defaultModelCredentialCandidates({
      provider: "openai-codex",
      modelId: "gpt-5.3-codex-spark",
      preferences: [
        {
          modelId: "gpt-5.3-codex-spark",
          thinkingLevel: null,
          updatedAt: new Date("2026-02-01T00:00:00.000Z"),
          credential: apiKey,
        },
        {
          modelId: "gpt-6-luna",
          thinkingLevel: null,
          updatedAt: new Date("2026-03-02T00:00:00.000Z"),
          credential: oauth,
        },
      ],
      credentials: [oauth, apiKey],
    });
    expect(candidates.map((item) => item.id)).toEqual(["api"]);
  });

  it("lists the latest preference before a credential that owns another model", () => {
    const apiKey = credential("api", "2026-01-01T00:00:00.000Z");
    const oauth = credential("oauth", "2026-03-01T00:00:00.000Z");
    const candidates = defaultModelCredentialCandidates({
      provider: "openai-codex",
      modelId: "gpt-6-luna",
      preferences: [
        {
          modelId: "gpt-5.3-codex-spark",
          thinkingLevel: null,
          updatedAt: new Date("2026-03-03T00:00:00.000Z"),
          credential: apiKey,
        },
        {
          modelId: "gpt-5.4",
          thinkingLevel: null,
          updatedAt: new Date("2026-03-02T00:00:00.000Z"),
          credential: oauth,
        },
      ],
      credentials: [apiKey, oauth],
    });
    expect(candidates.map((item) => item.id)).toEqual(["api", "oauth"]);
  });

  it("still offers the only credential when its preference owns a different model", () => {
    const apiKey = credential("api", "2026-01-01T00:00:00.000Z");
    const candidates = defaultModelCredentialCandidates({
      provider: "openai-codex",
      modelId: "gpt-6-luna",
      preferences: [
        {
          modelId: "gpt-5.3-codex-spark",
          thinkingLevel: null,
          updatedAt: apiKey.updatedAt,
          credential: apiKey,
        },
      ],
      credentials: [apiKey],
    });
    expect(candidates.map((item) => item.id)).toEqual(["api"]);
  });

  it("keeps the newest account credential when there is no preference", () => {
    const older = credential("older", "2026-01-01T00:00:00.000Z");
    const newest = credential("newest", "2026-04-01T00:00:00.000Z");
    expect(
      chooseModelCredential({
        provider: "openai-codex",
        modelId: "gpt-5.3-codex-spark",
        preferences: [],
        credentials: [older, newest],
      }),
    ).toEqual({ source: "credential", credential: newest });
  });
});

describe("saveModelPreference", () => {
  it.each([null, undefined, "null", "undefined", "  null  ", ""])(
    "does not persist %j as a model id",
    async (modelId) => {
      const upsert = vi.fn().mockResolvedValue({ id: "preference" });
      const prisma = { userModelPreference: { upsert } } as unknown as PrismaClient;

      await saveModelPreference(prisma, { userId: "user" }, "credential", modelId);

      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ modelId: null }),
          update: { modelId: null, thinkingLevel: null },
        }),
      );
    },
  );
});

it.each([
  ["azure", "azure-openai-responses"],
  ["azure-openai-responses", "azure"],
])("resolves %s through a saved %s credential and preference", async (provider, storedProvider) => {
  const credential = {
    id: "credential-azure",
    provider: storedProvider,
    userId: "user",
    label: "Azure",
    secretId: "secret-azure",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const preference = {
    modelId: "gpt-4o",
    thinkingLevel: null,
    updatedAt: new Date(0),
    credential,
  };
  const findPreferences = vi.fn().mockResolvedValue([preference]);
  const findCredentials = vi.fn().mockResolvedValue([credential]);
  const prisma = {
    userModelPreference: { findMany: findPreferences },
    userModelCredential: { findMany: findCredentials },
  } as unknown as PrismaClient;
  expect(await findModelCredential(prisma, { userId: "user" }, provider, "gpt-4o")).toMatchObject({
    id: credential.id,
    defaultModel: "gpt-4o",
  });
  expect(findCredentials).toHaveBeenCalledWith({
    where: { userId: "user", provider: { in: ["azure", "azure-openai-responses"] } },
  });
  expect(
    chooseModelCredential({
      provider,
      modelId: "gpt-4o",
      preferences: [],
      credentials: [credential],
    }),
  ).toEqual({ source: "credential", credential });
  expect(
    defaultModelCredentialCandidates({
      provider,
      modelId: "gpt-4o",
      preferences: [preference],
      credentials: [credential],
    }),
  ).toEqual([credential]);
});
