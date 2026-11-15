import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { deleteUnreferencedCredentialSecret, retireModelCredential } from "./credential-secrets.js";

function credentialSecretPrisma(modelReferences: number, voiceReferences: number) {
  return {
    userModelCredential: { count: vi.fn().mockResolvedValue(modelReferences) },
    userVoiceCredential: { count: vi.fn().mockResolvedValue(voiceReferences) },
    secret: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
  } as unknown as PrismaClient;
}

describe("deleteUnreferencedCredentialSecret", () => {
  it("deletes a replaced secret after both credential kinds release it", async () => {
    const prisma = credentialSecretPrisma(0, 0);

    await deleteUnreferencedCredentialSecret(prisma, {
      credentialKind: "model",
      credentialId: "credential",
      secretId: "secret",
    });

    expect(prisma.userModelCredential.count).toHaveBeenCalledWith({
      where: { id: { not: "credential" }, secretId: "secret" },
    });
    expect(prisma.userVoiceCredential.count).toHaveBeenCalledWith({
      where: { secretId: "secret" },
    });
    expect(prisma.secret.deleteMany).toHaveBeenCalledWith({ where: { id: "secret" } });
  });

  it("keeps a secret while either credential kind still references it", async () => {
    const prisma = credentialSecretPrisma(0, 1);

    await deleteUnreferencedCredentialSecret(prisma, {
      credentialKind: "voice",
      credentialId: "credential",
      secretId: "secret",
    });

    expect(prisma.secret.deleteMany).not.toHaveBeenCalled();
  });
});

type StoredCredentialRow = {
  id: string;
  userId: string;
  provider: string;
  secretId: string;
};

type StoredPreferenceRow = {
  id: string;
  spaceId: string;
  userId: string;
  credentialId: string;
};

type StoredSecretRow = { id: string; ciphertext?: string };

function retirePrisma(state: {
  credentials: StoredCredentialRow[];
  preferences: StoredPreferenceRow[];
  secrets: StoredSecretRow[];
  voiceCredentials?: StoredCredentialRow[];
}) {
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
        state.preferences = state.preferences.filter(
          (row) => !(row.userId === removed!.userId && row.credentialId === removed!.id),
        );
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
      count: vi.fn(
        async (args: { where: { secretId: string } }) =>
          (state.voiceCredentials ?? []).filter((row) => row.secretId === args.where.secretId)
            .length,
      ),
    },
    secret: {
      findFirst: vi.fn(
        async (args: { where: { id: string }; select?: Record<string, boolean> }) =>
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
  } as unknown as PrismaClient;
  return { prisma, tx };
}

const RECONNECT_MARKER = "reconnect-marker";

function codexCredential(overrides: Partial<StoredCredentialRow> = {}): StoredCredentialRow {
  return {
    id: "cred-codex",
    userId: "user-1",
    provider: "openai-codex",
    secretId: "secret-codex",
    ...overrides,
  };
}

function codexPreference(overrides: Partial<StoredPreferenceRow> = {}): StoredPreferenceRow {
  return {
    id: "pref-codex",
    spaceId: "ws-1",
    userId: "user-1",
    credentialId: "cred-codex",
    ...overrides,
  };
}

describe("retireModelCredential", () => {
  it("keeps the credential, its space preferences, and its secret on a dead refresh", async () => {
    const state = {
      credentials: [codexCredential()],
      preferences: [
        codexPreference(),
        codexPreference({ id: "pref-other-space", spaceId: "ws-2" }),
      ],
      secrets: [{ id: "secret-codex" }],
    };
    const { prisma, tx } = retirePrisma(state);

    await expect(
      retireModelCredential(prisma, {
        userId: "user-1",
        credentialId: "cred-codex",
        secretId: "secret-codex",
        replacementCiphertext: RECONNECT_MARKER,
      }),
    ).resolves.toBe(true);

    expect(state.credentials).toHaveLength(1);
    expect(state.preferences).toHaveLength(2);
    expect(state.secrets).toEqual([{ id: "secret-codex", ciphertext: RECONNECT_MARKER }]);
    expect(tx.userModelCredential.delete).not.toHaveBeenCalled();
    expect(tx.secret.deleteMany).not.toHaveBeenCalled();
  });

  it("keeps a secret still referenced by another credential", async () => {
    const state = {
      credentials: [codexCredential(), codexCredential({ id: "cred-voice-shared" })],
      preferences: [codexPreference()],
      secrets: [{ id: "secret-codex" }],
    };
    const { prisma } = retirePrisma(state);

    await retireModelCredential(prisma, {
      userId: "user-1",
      credentialId: "cred-codex",
      secretId: "secret-codex",
      replacementCiphertext: RECONNECT_MARKER,
    });

    expect(state.credentials).toHaveLength(2);
    expect(state.secrets).toEqual([{ id: "secret-codex", ciphertext: RECONNECT_MARKER }]);
  });

  it("skips deletion when the stored secret no longer matches the failed state", async () => {
    // A concurrent successful refresh rewrote the same secret row in place, so
    // the row still on the credential holds newer material than the failure.
    const state = {
      credentials: [codexCredential()],
      preferences: [codexPreference()],
      secrets: [{ id: "secret-codex", ciphertext: "cipher-rotated" }],
    };
    const { prisma, tx } = retirePrisma(state);

    await expect(
      retireModelCredential(prisma, {
        userId: "user-1",
        credentialId: "cred-codex",
        secretId: "secret-codex",
        matchesFailedSecret: (row) => row.ciphertext === "cipher-failed",
        replacementCiphertext: RECONNECT_MARKER,
      }),
    ).resolves.toBe(false);

    expect(tx.secret.findFirst).toHaveBeenCalledWith({
      where: { id: "secret-codex" },
      select: { id: true, ciphertext: true },
    });
    expect(tx.userModelCredential.delete).not.toHaveBeenCalled();
    expect(tx.secret.update).not.toHaveBeenCalled();
    expect(state.credentials).toHaveLength(1);
    expect(state.preferences).toHaveLength(1);
    expect(state.secrets).toEqual([{ id: "secret-codex", ciphertext: "cipher-rotated" }]);
  });

  it("reports retirement but keeps the credential when the stored secret matches the failed state", async () => {
    const state = {
      credentials: [codexCredential()],
      preferences: [codexPreference()],
      secrets: [{ id: "secret-codex", ciphertext: "cipher-failed" }],
    };
    const { prisma } = retirePrisma(state);

    await retireModelCredential(prisma, {
      userId: "user-1",
      credentialId: "cred-codex",
      secretId: "secret-codex",
      matchesFailedSecret: (row) => row.ciphertext === "cipher-failed",
      replacementCiphertext: RECONNECT_MARKER,
    });

    expect(state.credentials).toHaveLength(1);
    expect(state.preferences).toHaveLength(1);
    expect(state.secrets).toEqual([{ id: "secret-codex", ciphertext: RECONNECT_MARKER }]);
  });

  it("keeps the credential even when the secret row is already gone", async () => {
    const state = {
      credentials: [codexCredential()],
      preferences: [codexPreference()],
      secrets: [],
    };
    const { prisma } = retirePrisma(state);

    await retireModelCredential(prisma, {
      userId: "user-1",
      credentialId: "cred-codex",
      secretId: "secret-codex",
      matchesFailedSecret: () => false,
      replacementCiphertext: RECONNECT_MARKER,
    });

    expect(state.credentials).toHaveLength(1);
    expect(state.preferences).toHaveLength(1);
    expect(state.secrets).toEqual([]);
  });

  it("leaves a credential alone when it already moved to a new secret", async () => {
    const state = {
      credentials: [codexCredential({ secretId: "secret-reconnected" })],
      preferences: [codexPreference()],
      secrets: [{ id: "secret-reconnected" }],
    };
    const { prisma, tx } = retirePrisma(state);

    await retireModelCredential(prisma, {
      userId: "user-1",
      credentialId: "cred-codex",
      secretId: "secret-codex",
      replacementCiphertext: RECONNECT_MARKER,
    });

    expect(state.credentials).toHaveLength(1);
    expect(state.preferences).toHaveLength(1);
    expect(state.secrets).toEqual([{ id: "secret-reconnected" }]);
    expect(tx.userModelCredential.delete).not.toHaveBeenCalled();
    expect(tx.secret.update).not.toHaveBeenCalled();
  });

  it("does not delete another user's credential", async () => {
    const state = {
      credentials: [codexCredential({ userId: "user-2" })],
      preferences: [codexPreference({ userId: "user-2" })],
      secrets: [{ id: "secret-codex" }],
    };
    const { prisma, tx } = retirePrisma(state);

    await retireModelCredential(prisma, {
      userId: "user-1",
      credentialId: "cred-codex",
      secretId: "secret-codex",
      replacementCiphertext: RECONNECT_MARKER,
    });

    expect(state.credentials).toHaveLength(1);
    expect(state.preferences).toHaveLength(1);
    expect(state.secrets).toEqual([{ id: "secret-codex" }]);
    expect(tx.secret.update).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "checks slow provider material outside transactions and fences a concurrent rotation (%s)",
    async (rotate) => {
      const state = {
        credentials: [codexCredential()],
        preferences: [codexPreference()],
        secrets: [{ id: "secret-codex", ciphertext: "failed" }],
      };
      const { prisma, tx } = retirePrisma(state);
      tx.secret.findFirst.mockImplementation(async (args) => {
        const row = state.secrets.find((row) => row.id === args.where.id);
        return row ? { ...row } : null;
      });
      let active = false;
      let clock = 0;
      vi.mocked(prisma.$transaction).mockImplementation((async (
        callback: (client: typeof tx) => Promise<unknown>,
      ) => {
        const start = clock;
        active = true;
        try {
          const result = await callback(tx);
          if (clock - start > 5000) throw new Error("Transaction expired");
          return result;
        } finally {
          active = false;
        }
      }) as never);
      const retired = await retireModelCredential(prisma, {
        userId: "user-1",
        credentialId: "cred-codex",
        secretId: "secret-codex",
        replacementCiphertext: RECONNECT_MARKER,
        matchesFailedSecret: async () => {
          expect(active).toBe(false);
          clock += 15000;
          if (rotate) state.secrets[0]!.ciphertext = "fresh";
          return true;
        },
      });
      expect(retired).toBe(!rotate);
      expect(state.credentials).toHaveLength(1);
      expect(state.secrets[0]?.ciphertext).toBe(rotate ? "fresh" : RECONNECT_MARKER);
    },
  );

  it("is a no-op without a credential id", async () => {
    const { prisma } = retirePrisma({
      credentials: [codexCredential()],
      preferences: [codexPreference()],
      secrets: [{ id: "secret-codex" }],
    });

    await retireModelCredential(prisma, {
      userId: "user-1",
      credentialId: "",
      secretId: "secret-codex",
    });

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
