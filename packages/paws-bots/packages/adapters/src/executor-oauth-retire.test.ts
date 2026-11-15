import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunExecutor } from "./executor.js";
import { serializeModelSecret } from "./model-secret.js";
import { modelCredentialAuthKindsForSpace } from "./model-selection.js";
import { OAUTH_RECONNECT_REQUIRED_ERROR } from "./pi-oauth.js";

const SCOPE = { userId: "user-1", spaceId: "ws-1" };
const PROVIDER = "openai-codex";
const MODEL_ID = "gpt-6-luna";

const stamp = new Date("2026-08-30T00:00:00.000Z");

/**
 * Minimal stateful prisma for the model-credential path: preference finders,
 * the secret row resolver, and the $transaction retireModelCredential uses.
 */
function oauthPrisma() {
  const state = {
    credentials: [
      {
        id: "cred-codex",
        userId: SCOPE.userId,
        provider: PROVIDER,
        label: "ChatGPT Plus/Pro",
        secretId: "secret-codex",
        supportsImages: false,
        createdAt: stamp,
        updatedAt: stamp,
      },
    ],
    preferences: [
      {
        userId: SCOPE.userId,
        credentialId: "cred-codex",
        modelId: MODEL_ID,
        createdAt: stamp,
        updatedAt: stamp,
      },
    ],
    secrets: [
      {
        id: "secret-codex",
        userId: SCOPE.userId,
        spaceId: null,
        kind: "model",
        ciphertext: "cipher-codex",
      },
    ],
  };
  const tx = {
    userModelCredential: {
      findFirst: vi.fn(
        async (args: { where: { id: string; userId: string } }) =>
          state.credentials.find(
            (row) => row.id === args.where.id && row.userId === args.where.userId,
          ) ?? null,
      ),
      delete: vi.fn(async (args: { where: { id: string } }) => {
        const index = state.credentials.findIndex((row) => row.id === args.where.id);
        if (index < 0) return null;
        const [removed] = state.credentials.splice(index, 1);
        // The foreign key removes the connection's own model with it.
        state.preferences = state.preferences.filter((row) => row.credentialId !== removed!.id);
        return removed;
      }),
      count: vi.fn(
        async (args: { where: { secretId: string; id?: { not: string } } }) =>
          state.credentials.filter(
            (row) => row.secretId === args.where.secretId && row.id !== args.where.id?.not,
          ).length,
      ),
    },
    userVoiceCredential: {
      count: vi.fn(async () => 0),
    },
    $executeRaw: vi.fn(async () => 0),
    secret: {
      findFirst: vi.fn(
        async (args: { where: { id: string }; select?: Record<string, boolean> }) =>
          state.secrets.find((row) => row.id === args.where.id) ?? null,
      ),
      findUnique: vi.fn(
        async (args: { where: { id: string } }) =>
          state.secrets.find((row) => row.id === args.where.id) ?? null,
      ),
      deleteMany: vi.fn(async (args: { where: { id: string } }) => {
        const before = state.secrets.length;
        state.secrets = state.secrets.filter((row) => row.id !== args.where.id);
        return { count: before - state.secrets.length };
      }),
      update: vi.fn(async (args: { where: { id: string }; data: { ciphertext: string } }) => {
        const row = state.secrets.find((secret) => secret.id === args.where.id);
        if (!row) throw new Error("missing secret");
        row.ciphertext = args.data.ciphertext;
        return row;
      }),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (txArg: typeof tx) => Promise<unknown>) => callback(tx)),
    userModelCredential: {
      findMany: vi.fn(async () => [...state.credentials]),
      findFirst: vi.fn(async () => state.credentials[0] ?? null),
    },
    userModelPreference: {
      findMany: vi.fn(async () =>
        state.preferences.map((preference) => ({
          ...preference,
          credential: state.credentials.find((row) => row.id === preference.credentialId) ?? null,
        })),
      ),
      findFirst: vi.fn(async () => {
        const preference = state.preferences[0];
        if (!preference) return null;
        return {
          ...preference,
          credential: state.credentials.find((row) => row.id === preference.credentialId) ?? null,
        };
      }),
    },
    secret: {
      findFirst: vi.fn(
        async (args: { where: { id: string; userId: string; spaceId: null } }) =>
          state.secrets.find(
            (row) =>
              row.id === args.where.id && row.userId === args.where.userId && row.spaceId === null,
          ) ?? null,
      ),
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
        state.secrets.filter((row) => args.where.id.in.includes(row.id)),
      ),
      update: vi.fn(async () => null),
    },
  } as unknown as PrismaClient;
  return { prisma, state };
}

function expiredOAuthPlaintext() {
  return serializeModelSecret({
    kind: "oauth",
    credential: { type: "oauth", access: "access-token", refresh: "refresh-token", expires: 1 },
    maxTokens: 4096,
  });
}

function rotatedOAuthPlaintext() {
  return serializeModelSecret({
    kind: "oauth",
    credential: {
      type: "oauth",
      access: "rotated-access",
      refresh: "rotated-refresh",
      expires: Date.now() + 3600_000,
    },
  });
}

function oauthExecutor(
  prisma: PrismaClient,
  load: (ciphertext: string, secretId: string) => string = (ciphertext) =>
    ciphertext.startsWith("sealed:") ? ciphertext.slice("sealed:".length) : expiredOAuthPlaintext(),
) {
  const secretStore = {
    load: vi.fn(load),
    put: vi.fn(async (plaintext: string) => ({
      id: "secret-codex",
      ref: `sealed:${plaintext}`,
      ciphertext: `sealed:${plaintext}`,
    })),
    delete: vi.fn(async () => undefined),
  };
  const executor = createRunExecutor({
    billingEnabled: false,
    prisma,
    secretStore,
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  return { executor, secretStore };
}

describe("OAuth credential retirement on terminal refresh rejection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the credential and drops the rejected tokens after invalid_grant", async () => {
    // The real pi codex refresh posts to the token endpoint; a 400 body with a
    // terminal marker surfaces in the thrown error's message.
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "invalid_grant", error_description: "gone" }), {
          status: 400,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { prisma, state } = oauthPrisma();
    const { executor, secretStore } = oauthExecutor(prisma);

    await expect(executor.resolveConnectedModel(SCOPE, PROVIDER, MODEL_ID)).rejects.toThrow(
      OAUTH_RECONNECT_REQUIRED_ERROR,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The connection and model choices stay so signing in again renews them.
    // The rejected access and refresh tokens are replaced and are not sent again.
    expect(state.credentials).toHaveLength(1);
    expect(state.preferences).toHaveLength(1);
    expect(state.secrets).toHaveLength(1);
    const stored = state.secrets[0]?.ciphertext ?? "";
    expect(stored.startsWith("sealed:")).toBe(true);
    const marker = stored.slice("sealed:".length);
    expect(marker).not.toContain("access-token");
    expect(marker).not.toContain("refresh-token");
    expect(JSON.parse(marker)).toEqual({ kind: "oauth", reconnectRequired: true, maxTokens: 4096 });
    expect(secretStore.delete).toHaveBeenCalledExactlyOnceWith("cipher-codex", "secret-codex");

    await expect(executor.resolveConnectedModel(SCOPE, PROVIDER, MODEL_ID)).rejects.toThrow(
      OAUTH_RECONNECT_REQUIRED_ERROR,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the credential when the refresh failure is transient", async () => {
    const fetchMock = vi.fn(async () => new Response("upstream exploded", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const { prisma, state } = oauthPrisma();
    const { executor } = oauthExecutor(prisma);

    await expect(executor.resolveConnectedModel(SCOPE, PROVIDER, MODEL_ID)).rejects.toThrow(/500/);

    expect(state.credentials).toHaveLength(1);
    expect(state.preferences).toHaveLength(1);
    expect(state.secrets).toHaveLength(1);
    const auth = await modelCredentialAuthKindsForSpace(
      prisma,
      { load: vi.fn(async () => expiredOAuthPlaintext()) },
      SCOPE,
    );
    expect(auth.byProvider[PROVIDER]).toBe("oauth");
  });

  it("keeps the credential when a 5xx response quotes a terminal marker", async () => {
    // A gateway error can echo an OAuth error body; the 5xx status means the
    // rejection is not a terminal judgment on the stored refresh token.
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "invalid_grant", error_description: "gone" }), {
          status: 502,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { prisma, state } = oauthPrisma();
    const { executor } = oauthExecutor(prisma);

    await expect(executor.resolveConnectedModel(SCOPE, PROVIDER, MODEL_ID)).rejects.toThrow(/502/);

    expect(state.credentials).toHaveLength(1);
    expect(state.preferences).toHaveLength(1);
    expect(state.secrets).toHaveLength(1);
  });

  it("keeps a credential a concurrent refresh already rewrote", async () => {
    // A writer outside the refresh lock (a run persisting its own refresh) rotated
    // the tokens while this refresh was failing; the stale failure must not delete
    // the newer material.
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "invalid_grant", error_description: "gone" }), {
          status: 400,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { prisma, state } = oauthPrisma();
    const load = vi
      .fn()
      .mockImplementationOnce(() => expiredOAuthPlaintext())
      .mockImplementationOnce(() => expiredOAuthPlaintext())
      .mockImplementation(() => rotatedOAuthPlaintext());
    const { executor, secretStore } = oauthExecutor(prisma, load);

    await expect(executor.resolveConnectedModel(SCOPE, PROVIDER, MODEL_ID)).rejects.toThrow(
      /invalid_grant/,
    );

    expect(state.credentials).toHaveLength(1);
    expect(state.preferences).toHaveLength(1);
    expect(state.secrets).toEqual([
      expect.objectContaining({ id: "secret-codex", ciphertext: "cipher-codex" }),
    ]);
    // The marker sealed for the skipped replacement is not left behind.
    expect(secretStore.delete).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/^sealed:.*reconnectRequired/),
      "secret-codex",
    );
    const auth = await modelCredentialAuthKindsForSpace(
      prisma,
      { load: vi.fn(async () => rotatedOAuthPlaintext()) },
      SCOPE,
    );
    expect(auth.byProvider[PROVIDER]).toBe("oauth");
  });
});
