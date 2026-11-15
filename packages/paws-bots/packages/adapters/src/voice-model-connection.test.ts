import type { SecretStore } from "@rakazo/adapter-kit";
import { VoiceAccountError } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { serializeModelSecret } from "./model-secret.js";
import type { VoiceKeyDeps } from "./voice-model-connection.js";
import { MODEL_CONNECTION_VOICE_SECRET, resolveVoiceKey } from "./voice-model-connection.js";

const scope = { userId: "user-1", spaceId: "space-1" };

function credential(id: string, updatedAt: number) {
  return {
    id,
    userId: scope.userId,
    provider: "xai",
    label: id,
    secretId: `secret-${id}`,
    createdAt: new Date(updatedAt),
    updatedAt: new Date(updatedAt),
  };
}

function deps(options: {
  credentials?: ReturnType<typeof credential>[];
  secrets?: Record<string, string>;
}) {
  const secrets = options.secrets ?? {};
  const prisma = {
    $transaction: vi.fn(),
    userModelPreference: { findMany: vi.fn(async () => []) },
    userModelCredential: { findMany: vi.fn(async () => options.credentials ?? []) },
    secret: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id in secrets ? { id: where.id, ciphertext: `cipher:${where.id}` } : null,
      ),
    },
  };
  const secretStore: Pick<SecretStore, "load" | "put" | "delete"> = {
    load: vi.fn(async (_ref: string, context: Parameters<SecretStore["load"]>[1]) => {
      const id = typeof context === "string" ? context : context.recordId;
      return secrets[id] ?? "";
    }),
    put: vi.fn(),
    delete: vi.fn(),
  };
  return { prisma, secretStore, deps: { prisma, secretStore } as unknown as VoiceKeyDeps };
}

describe("resolveVoiceKey", () => {
  it("returns a stored key unchanged without reading the model connection", async () => {
    const { prisma, deps: d } = deps({});
    await expect(resolveVoiceKey(d, scope, "xai", "xai-own-voice-key")).resolves.toBe(
      "xai-own-voice-key",
    );
    expect(prisma.userModelCredential.findMany).not.toHaveBeenCalled();
    expect(prisma.secret.findFirst).not.toHaveBeenCalled();
  });

  it("treats the marker as a pasted key for a provider that cannot use the model connection", async () => {
    const { prisma, deps: d } = deps({});
    await expect(resolveVoiceKey(d, scope, "openai", MODEL_CONNECTION_VOICE_SECRET)).resolves.toBe(
      MODEL_CONNECTION_VOICE_SECRET,
    );
    expect(prisma.userModelCredential.findMany).not.toHaveBeenCalled();
  });

  it("uses the API key of the newest xAI model connection", async () => {
    const { deps: d } = deps({
      credentials: [credential("old", 1_000), credential("new", 2_000)],
      secrets: { "secret-old": "xai-old-model-key", "secret-new": "xai-new-model-key" },
    });
    await expect(resolveVoiceKey(d, scope, "xai", MODEL_CONNECTION_VOICE_SECRET)).resolves.toBe(
      "xai-new-model-key",
    );
  });

  // A due refresh takes a Postgres advisory lock and calls the provider, so only a current
  // sign-in is covered here.
  it("uses the access token of a current Grok sign-in", async () => {
    const secret = serializeModelSecret({
      kind: "oauth",
      credential: {
        type: "oauth",
        access: "grok-access-token",
        refresh: "grok-refresh-token",
        expires: Date.now() + 60 * 60_000,
      },
    } as Parameters<typeof serializeModelSecret>[0]);
    const { prisma, deps: d } = deps({
      credentials: [credential("signin", 1_000)],
      secrets: { "secret-signin": secret },
    });
    await expect(resolveVoiceKey(d, scope, "xai", MODEL_CONNECTION_VOICE_SECRET)).resolves.toBe(
      "grok-access-token",
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ["no model connection", {}],
    ["a model connection whose secret is gone", { credentials: [credential("gone", 1_000)] }],
    [
      "a model connection that needs reconnecting",
      {
        credentials: [credential("retired", 1_000)],
        secrets: {
          "secret-retired": serializeModelSecret({ kind: "oauth", reconnectRequired: true }),
        },
      },
    ],
  ])("asks to connect xAI in Models settings for %s", async (_name, options) => {
    const { deps: d } = deps(options);
    const error = await resolveVoiceKey(d, scope, "xai", MODEL_CONNECTION_VOICE_SECRET).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(VoiceAccountError);
    expect(error).toMatchObject({ code: undefined, message: "Connect xAI in Models settings." });
  });
});
