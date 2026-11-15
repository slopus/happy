import { VoiceAccountError } from "@rakazo/adapter-kit";
import * as adapters from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import * as db from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceDeps } from "./voice.js";
import {
  accountVoiceCatalog,
  disconnectVoiceCredential,
  isVoiceProviderFailure,
  MAX_SPEAK_REQUEST_BYTES,
  MAX_TRANSCRIBE_REQUEST_BYTES,
  mountVoiceHttpRoutes,
  persistVoiceCredential,
  prepareVoice,
  speechModelValue,
  synthesizeVoice,
  toVoiceCredential,
  toVoiceStatus,
  transcribeInboundVoice,
  updateVoiceSpeechModel,
  voiceChoicesChanged,
  voiceCredentialHasKey,
  voiceCredentialPlaintext,
  voiceCredentialServer,
  withVoiceConnection,
} from "./voice.js";

describe("toVoiceStatus", () => {
  it("treats a saved key without a voice as configured but not ready", () => {
    expect(toVoiceStatus({ provider: "elevenlabs", voiceId: "" })).toEqual({
      configured: true,
      ready: false,
      transcribe: true,
      provider: "elevenlabs",
      voiceId: "",
    });
  });

  it("is ready once a voice is chosen", () => {
    expect(toVoiceStatus({ provider: "cartesia", voiceId: "katie" }).ready).toBe(true);
    expect(toVoiceStatus({ provider: "cartesia", voiceId: "katie" }).transcribe).toBe(false);
  });

  it("is off when nothing is connected", () => {
    expect(toVoiceStatus(null)).toEqual({
      configured: false,
      ready: false,
      transcribe: false,
      provider: null,
      voiceId: "",
    });
  });
});

describe("voice HTTP routes", () => {
  it("rejects unauthenticated speak and transcribe", async () => {
    const app = new Hono();
    mountVoiceHttpRoutes(app, {} as VoiceDeps, async () => null);
    const speak = await app.request("/api/voice/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    const transcribe = await app.request("/api/voice/transcribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ audioBase64: "AAAA", mimeType: "audio/webm" }),
    });
    expect(speak.status).toBe(401);
    expect(transcribe.status).toBe(401);
  });

  it.each([
    ["/api/voice/speak", MAX_SPEAK_REQUEST_BYTES],
    ["/api/voice/transcribe", MAX_TRANSCRIBE_REQUEST_BYTES],
  ])(
    "rejects a declared oversized body on %s without waiting for cancellation",
    async (path, max) => {
      const cancel = vi.fn(() => new Promise<void>(() => undefined));
      const request = new Request(`http://localhost${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(max + 1),
        },
        body: new ReadableStream({ cancel }),
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      const app = new Hono();
      mountVoiceHttpRoutes(
        app,
        {} as VoiceDeps,
        async () => ({ userId: "user", spaceId: "space" }) as Actor,
      );

      const response = await app.request(request);

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({ error: "Request body is too large." });
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("stops reading a streamed oversized speak body", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const request = new Request("http://localhost/api/voice/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_SPEAK_REQUEST_BYTES + 1));
        },
        cancel,
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const app = new Hono();
    mountVoiceHttpRoutes(
      app,
      {} as VoiceDeps,
      async () => ({ userId: "user", spaceId: "space" }) as Actor,
    );

    const response = await app.request(request);

    expect(response.status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
  });
});

const actor = { userId: "user-1", spaceId: "space-1" } as Actor;

/** Fixtures save as the deployment owner, who may use local speech servers. */
const serializeAsOwner = (
  input: Parameters<typeof adapters.serializeOpenAiCompatibleVoiceSecret>[0],
  previous?: string,
) => adapters.serializeOpenAiCompatibleVoiceSecret(input, previous, { allowPrivate: true });

const xaiModelCredential = {
  id: "model-cred-1",
  userId: actor.userId,
  provider: "xai",
  label: "xAI",
  secretId: "model-secret",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

/** The account's model connections and stored secrets, keyed by secret id. */
function modelConnectionDeps(
  plaintexts: Record<string, string>,
  prisma: Record<string, unknown> = {},
  modelCredentials = [xaiModelCredential],
) {
  return {
    prisma: {
      userModelPreference: { findMany: vi.fn().mockResolvedValue([]) },
      userModelCredential: { findMany: vi.fn().mockResolvedValue(modelCredentials) },
      secret: {
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
          where.id in plaintexts ? { id: where.id, ciphertext: `cipher:${where.id}` } : null,
        ),
      },
      ...prisma,
    },
    secrets: {
      load: vi.fn((ciphertext: string) => plaintexts[ciphertext.replace(/^cipher:/, "")]),
      put: vi.fn().mockResolvedValue({ id: "voice-secret", ciphertext: "cipher:voice-secret" }),
    },
  };
}

function makeDisconnectDeps(
  overrides: {
    existing?: Array<{ id: string; secretId: string; userId: string; provider: string }>;
    modelReferences?: number;
    voiceReferences?: number;
  } = {},
) {
  const rows = overrides.existing ?? [];
  const findMany = vi.fn().mockResolvedValue(rows);
  const preferenceDeleteMany = vi.fn().mockResolvedValue({ count: rows.length });
  const accountPreferenceDeleteMany = vi.fn().mockResolvedValue({ count: rows.length });
  const credentialDeleteMany = vi.fn().mockResolvedValue({ count: rows.length });
  const modelCount = vi.fn().mockResolvedValue(overrides.modelReferences ?? 0);
  const voiceCount = vi.fn().mockResolvedValue(overrides.voiceReferences ?? 0);
  const secretDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    userVoiceCredential: {
      findMany,
      deleteMany: credentialDeleteMany,
      count: voiceCount,
    },
    spaceVoicePreference: { deleteMany: preferenceDeleteMany },
    userVoicePreference: { deleteMany: accountPreferenceDeleteMany },
    userModelCredential: { count: modelCount },
    secret: { deleteMany: secretDeleteMany },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) =>
    callback(prisma),
  );
  const deps = {
    prisma: prisma as unknown as PrismaClient,
    secrets: { put: vi.fn(), load: vi.fn() },
  } as unknown as VoiceDeps;
  return {
    deps,
    findMany,
    preferenceDeleteMany,
    accountPreferenceDeleteMany,
    credentialDeleteMany,
    secretDeleteMany,
    transaction: prisma.$transaction,
  };
}

describe("disconnectVoiceCredential", () => {
  it("removes the actor credential, clears its default, and deletes an unreferenced secret", async () => {
    const existing = {
      id: "cred-1",
      secretId: "secret-1",
      userId: actor.userId,
      provider: "scripted",
    };
    const {
      deps,
      findMany,
      preferenceDeleteMany,
      accountPreferenceDeleteMany,
      credentialDeleteMany,
      secretDeleteMany,
    } = makeDisconnectDeps({ existing: [existing] });

    await expect(disconnectVoiceCredential(deps, actor, { provider: "scripted" })).resolves.toEqual(
      {
        ok: true,
      },
    );

    expect(findMany).toHaveBeenCalledWith({
      where: { userId: actor.userId, provider: "scripted" },
    });
    // From the account's voice and every Space's own.
    expect(accountPreferenceDeleteMany).toHaveBeenCalledWith({
      where: { userId: actor.userId, credentialId: { in: ["cred-1"] } },
    });
    expect(preferenceDeleteMany).toHaveBeenCalledWith({
      where: { userId: actor.userId, credentialId: { in: ["cred-1"] } },
    });
    expect(credentialDeleteMany).toHaveBeenCalledWith({
      where: { userId: actor.userId, id: { in: ["cred-1"] } },
    });
    expect(secretDeleteMany).toHaveBeenCalledWith({ where: { id: "secret-1" } });
  });

  it("removes every actor credential for that provider", async () => {
    const { deps, preferenceDeleteMany, credentialDeleteMany, secretDeleteMany } =
      makeDisconnectDeps({
        existing: [
          {
            id: "cred-new",
            secretId: "secret-new",
            userId: actor.userId,
            provider: "scripted",
          },
          {
            id: "cred-old",
            secretId: "secret-old",
            userId: actor.userId,
            provider: "scripted",
          },
        ],
      });

    await expect(disconnectVoiceCredential(deps, actor, { provider: "scripted" })).resolves.toEqual(
      {
        ok: true,
      },
    );

    expect(preferenceDeleteMany).toHaveBeenCalledWith({
      where: { userId: actor.userId, credentialId: { in: ["cred-new", "cred-old"] } },
    });
    expect(credentialDeleteMany).toHaveBeenCalledWith({
      where: { userId: actor.userId, id: { in: ["cred-new", "cred-old"] } },
    });
    expect(secretDeleteMany).toHaveBeenCalledWith({ where: { id: "secret-new" } });
    expect(secretDeleteMany).toHaveBeenCalledWith({ where: { id: "secret-old" } });
  });

  it("keeps a secret while another credential still references it", async () => {
    const { deps, credentialDeleteMany, secretDeleteMany } = makeDisconnectDeps({
      existing: [
        {
          id: "cred-1",
          secretId: "secret-shared",
          userId: actor.userId,
          provider: "scripted",
        },
      ],
      voiceReferences: 1,
    });

    await expect(disconnectVoiceCredential(deps, actor, { provider: "scripted" })).resolves.toEqual(
      {
        ok: true,
      },
    );

    expect(credentialDeleteMany).toHaveBeenCalled();
    expect(secretDeleteMany).not.toHaveBeenCalled();
  });

  it("does not delete another actor's credential", async () => {
    const { deps, findMany, preferenceDeleteMany, credentialDeleteMany, secretDeleteMany } =
      makeDisconnectDeps();

    await expect(
      disconnectVoiceCredential(deps, { ...actor, userId: "intruder" }, { provider: "scripted" }),
    ).resolves.toEqual({ ok: true });

    expect(findMany).toHaveBeenCalledWith({
      where: { userId: "intruder", provider: "scripted" },
    });
    expect(preferenceDeleteMany).not.toHaveBeenCalled();
    expect(credentialDeleteMany).not.toHaveBeenCalled();
    expect(secretDeleteMany).not.toHaveBeenCalled();
  });

  it("rejects a blank provider before opening a transaction", async () => {
    const { deps, transaction } = makeDisconnectDeps();

    await expect(disconnectVoiceCredential(deps, actor, { provider: "   " })).rejects.toMatchObject(
      {
        code: "BAD_REQUEST",
      },
    );
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("isVoiceProviderFailure", () => {
  it("treats provider refusals and timeouts as expected but keeps bugs reported", () => {
    expect(isVoiceProviderFailure(new Error("Fish Audio could not speak that (500)."))).toBe(true);
    expect(isVoiceProviderFailure(new DOMException("timed out", "TimeoutError"))).toBe(true);
    expect(isVoiceProviderFailure(new TypeError("Cannot read properties of undefined"))).toBe(
      false,
    );
    expect(isVoiceProviderFailure("boom")).toBe(false);
  });
});

describe("speechModelValue", () => {
  it("trims a model id and treats blank as no override", () => {
    expect(speechModelValue("  s1  ")).toBe("s1");
    expect(speechModelValue(" eleven_v4 ")).toBe("eleven_v4");
    expect(speechModelValue(" ")).toBeNull();
  });

  it("rejects a model id that cannot be a header or a JSON model id", () => {
    expect(() => speechModelValue("s1\ninjected")).toThrow("That speech model id is not valid.");
  });
});

describe("updateVoiceSpeechModel", () => {
  function speechDeps(
    preference: { voiceId: string; isDefault: boolean } | null,
    { overridden = false, provider = "fish-audio" } = {},
  ) {
    const credential = {
      id: "cred-1",
      userId: actor.userId,
      provider,
      secretId: "secret-1",
    };
    const table = () => ({
      findUnique: vi.fn().mockResolvedValue(preference),
      updateMany: vi.fn(),
      upsert: vi
        .fn()
        .mockImplementation(async ({ update }: { update: { speechModel: string | null } }) => ({
          voiceId: preference?.voiceId ?? "",
          isDefault: preference?.isDefault ?? false,
          speechModel: update.speechModel,
        })),
    });
    const prisma = {
      userVoiceCredential: { findFirst: vi.fn().mockResolvedValue(credential) },
      spaceSettingOverride: {
        findUnique: vi.fn().mockResolvedValue(overridden ? { setting: "voice" } : null),
      },
      userVoicePreference: table(),
      spaceVoicePreference: table(),
      $queryRaw: vi.fn().mockResolvedValue([{ locked: 1 }]),
      $transaction: vi.fn(),
    };
    prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) =>
      callback(prisma),
    );
    return {
      deps: { prisma, secrets: { put: vi.fn(), load: vi.fn() } } as unknown as VoiceDeps,
      account: prisma.userVoicePreference,
      space: prisma.spaceVoicePreference,
    };
  }

  it("stores the override without changing the selected voice", async () => {
    const { deps, account, space } = speechDeps({ voiceId: "voice-1", isDefault: false });

    await expect(
      updateVoiceSpeechModel(deps, actor, { provider: "fish-audio", speechModel: " s1 " }),
    ).resolves.toMatchObject({
      provider: "fish-audio",
      voiceId: "voice-1",
      speechModel: "s1",
      isDefault: false,
    });
    expect(account.upsert).toHaveBeenCalledWith({
      where: { userId_credentialId: { userId: actor.userId, credentialId: "cred-1" } },
      create: { userId: actor.userId, credentialId: "cred-1", speechModel: "s1" },
      update: { speechModel: "s1" },
    });
    expect(account.updateMany).not.toHaveBeenCalled();
    expect(space.upsert).not.toHaveBeenCalled();
  });

  it("stores an ElevenLabs speech model", async () => {
    const { deps, account } = speechDeps(
      { voiceId: "rachel", isDefault: true },
      { provider: "elevenlabs" },
    );

    await expect(
      updateVoiceSpeechModel(deps, actor, { provider: "elevenlabs", speechModel: "eleven_v4" }),
    ).resolves.toMatchObject({
      provider: "elevenlabs",
      voiceId: "rachel",
      speechModel: "eleven_v4",
    });
    expect(account.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { speechModel: "eleven_v4" } }),
    );
  });

  it("clears the override when the model is blank", async () => {
    const { deps, account } = speechDeps({ voiceId: "voice-1", isDefault: true });

    await expect(
      updateVoiceSpeechModel(deps, actor, { provider: "fish-audio", speechModel: " " }),
    ).resolves.toMatchObject({ speechModel: "" });
    expect(account.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { speechModel: null } }),
    );
  });

  it("stores a model before a voice is chosen without replacing the default", async () => {
    const { deps, account } = speechDeps(null);

    await expect(
      updateVoiceSpeechModel(deps, actor, { provider: "fish-audio", speechModel: "s1" }),
    ).resolves.toMatchObject({
      provider: "fish-audio",
      voiceId: "",
      speechModel: "s1",
      isDefault: false,
    });
    expect(account.upsert).toHaveBeenCalledOnce();
    expect(account.updateMany).not.toHaveBeenCalled();
  });

  it("writes the Space's own copy in a Space that overrides voice", async () => {
    const { deps, account, space } = speechDeps(
      { voiceId: "voice-1", isDefault: true },
      { overridden: true },
    );

    await updateVoiceSpeechModel(deps, actor, { provider: "fish-audio", speechModel: "s1" });

    expect(space.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          spaceId_userId_credentialId: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            credentialId: "cred-1",
          },
        },
        update: { speechModel: "s1" },
      }),
    );
    expect(account.upsert).not.toHaveBeenCalled();
  });

  it("rejects speech models for other providers before writing", async () => {
    const { deps, account } = speechDeps({ voiceId: "voice-1", isDefault: true });

    await expect(
      updateVoiceSpeechModel(deps, actor, { provider: "openai", speechModel: "s1" }),
    ).rejects.toThrow("This voice provider has no speech model.");
    expect(account.upsert).not.toHaveBeenCalled();
  });
});

describe("prepareVoice", () => {
  const long = "The deploy finished and every check passed. ".repeat(20);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function depsWith(summarize?: ReturnType<typeof vi.fn>) {
    const prisma = {
      bot: { findFirst: vi.fn().mockResolvedValue({ voiceId: "voice-1" }) },
      spaceSettingOverride: { findUnique: vi.fn().mockResolvedValue(null) },
      userVoicePreference: {
        findFirst: vi.fn().mockResolvedValue({
          isDefault: true,
          voiceId: "voice-1",
          speechModel: "",
          credential: {
            id: "cred-1",
            userId: actor.userId,
            provider: "elevenlabs",
            secretId: "secret-1",
            createdAt: new Date(0),
            updatedAt: new Date(0),
          },
        }),
      },
      secret: { findFirst: vi.fn().mockResolvedValue({ id: "secret-1", ciphertext: "c" }) },
    };
    return {
      prisma,
      secrets: { load: vi.fn().mockReturnValue("key"), put: vi.fn() },
      speechSummary: summarize ? { summarize, minChars: 600 } : undefined,
    } as unknown as VoiceDeps;
  }

  it("reads a long bot reply as the bot model's summary", async () => {
    const summarize = vi.fn().mockResolvedValue("Deploy done. Next, the release notes.");
    const result = await prepareVoice(depsWith(summarize), actor, { text: long, botId: "bot-1" });
    expect(summarize).toHaveBeenCalledWith(actor, "bot-1", long, undefined);
    expect(result).toEqual({
      ready: true,
      utterances: ["Deploy done.", "Next, the release notes."],
    });
  });

  it.each([
    ["Chinese", "中".repeat(2400)],
    ["Japanese", "あ".repeat(2400)],
  ])("synthesizes long %s replies in full without a summary", async (_name, text) => {
    const synthesize = vi
      .fn()
      .mockResolvedValue({ bytes: new Uint8Array([1]), mimeType: "audio/mpeg" });
    vi.spyOn(adapters, "createVoiceProvider").mockReturnValue({ synthesize } as never);

    for (const summarize of [undefined, vi.fn().mockResolvedValue(null)]) {
      const deps = depsWith(summarize);
      const result = await prepareVoice(deps, actor, { text, botId: "bot-1" });
      expect(result.ready).toBe(true);
      const app = new Hono();
      mountVoiceHttpRoutes(app, deps, async () => actor);
      synthesize.mockClear();

      for (const utterance of result.utterances) {
        const response = await app.request("/api/voice/speak", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: utterance, botId: "bot-1" }),
        });
        expect(response.status).toBe(200);
      }

      expect(result.utterances.length).toBeGreaterThan(1);
      expect(result.utterances.join("")).toBe(text);
      expect(synthesize.mock.calls.map(([request]) => request.text)).toEqual(result.utterances);
    }
  });

  it("reads short replies, and replies when summarizing fails or is not enabled, in full", async () => {
    const failing = vi.fn().mockResolvedValue(null);
    const short = await prepareVoice(depsWith(failing), actor, { text: "Done.", botId: "bot-1" });
    expect(short.utterances).toEqual(["Done."]);
    expect(failing).not.toHaveBeenCalled();

    const failed = await prepareVoice(depsWith(failing), actor, { text: long, botId: "bot-1" });
    expect(failed.utterances.join(" ")).toContain("every check passed");

    const unspeakable = vi.fn().mockResolvedValue("🎉");
    const empty = await prepareVoice(depsWith(unspeakable), actor, { text: long, botId: "bot-1" });
    expect(empty.utterances.join(" ")).toContain("every check passed");

    const off = await prepareVoice(depsWith(), actor, { text: long, botId: "bot-1" });
    expect(off.utterances.join(" ")).toContain("every check passed");
  });
});

describe("synthesizeVoice", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends the speech model stored on that connection", async () => {
    const synthesize = vi
      .fn()
      .mockResolvedValue({ bytes: new Uint8Array(), mimeType: "audio/mpeg" });
    vi.spyOn(adapters, "createVoiceProvider").mockReturnValue({ synthesize } as never);
    const prisma = {
      spaceSettingOverride: { findUnique: vi.fn().mockResolvedValue(null) },
      userVoicePreference: {
        findFirst: vi.fn().mockResolvedValue({
          isDefault: true,
          voiceId: "voice-1",
          speechModel: "s1",
          credential: {
            id: "cred-1",
            userId: actor.userId,
            provider: "fish-audio",
            secretId: "secret-1",
            createdAt: new Date(0),
            updatedAt: new Date(0),
          },
        }),
      },
      secret: {
        findFirst: vi.fn().mockResolvedValue({ id: "secret-1", ciphertext: "cipher" }),
      },
    };
    const deps = {
      prisma,
      secrets: { load: vi.fn().mockReturnValue("fish-key"), put: vi.fn() },
    } as unknown as VoiceDeps;

    await synthesizeVoice(deps, actor, { text: "Hello" });

    expect(synthesize).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Hello",
        voiceId: "voice-1",
        apiKey: "fish-key",
        model: "s1",
      }),
      expect.anything(),
    );
  });

  it("omits the model when the connection has no override", async () => {
    const synthesize = vi
      .fn()
      .mockResolvedValue({ bytes: new Uint8Array(), mimeType: "audio/mpeg" });
    vi.spyOn(adapters, "createVoiceProvider").mockReturnValue({ synthesize } as never);
    const prisma = {
      spaceSettingOverride: { findUnique: vi.fn().mockResolvedValue(null) },
      userVoicePreference: {
        findFirst: vi.fn().mockResolvedValue({
          isDefault: true,
          voiceId: "voice-1",
          speechModel: null,
          credential: {
            id: "cred-1",
            userId: actor.userId,
            provider: "fish-audio",
            secretId: "secret-1",
            createdAt: new Date(0),
            updatedAt: new Date(0),
          },
        }),
      },
      secret: {
        findFirst: vi.fn().mockResolvedValue({ id: "secret-1", ciphertext: "cipher" }),
      },
    };
    const deps = {
      prisma,
      secrets: { load: vi.fn().mockReturnValue("fish-key"), put: vi.fn() },
    } as unknown as VoiceDeps;

    await synthesizeVoice(deps, actor, { text: "Hello" });

    expect(synthesize.mock.calls[0]?.[0]).toMatchObject({ model: undefined });
  });

  it("speaks with the account voice when asked for it in a Space that overrides voice", async () => {
    const synthesize = vi
      .fn()
      .mockResolvedValue({ bytes: new Uint8Array(), mimeType: "audio/mpeg" });
    vi.spyOn(adapters, "createVoiceProvider").mockReturnValue({ synthesize } as never);
    const preference = (voiceId: string) => ({
      isDefault: true,
      voiceId,
      speechModel: null,
      credential: {
        id: "cred-1",
        userId: actor.userId,
        provider: "fish-audio",
        secretId: "secret-1",
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    });
    const prisma = {
      spaceSettingOverride: { findUnique: vi.fn().mockResolvedValue({ setting: "voice" }) },
      userVoicePreference: { findFirst: vi.fn().mockResolvedValue(preference("account-voice")) },
      spaceVoicePreference: { findFirst: vi.fn().mockResolvedValue(preference("space-voice")) },
      secret: {
        findFirst: vi.fn().mockResolvedValue({ id: "secret-1", ciphertext: "cipher" }),
      },
    };
    const deps = {
      prisma,
      secrets: { load: vi.fn().mockReturnValue("fish-key"), put: vi.fn() },
    } as unknown as VoiceDeps;

    await synthesizeVoice(deps, actor, { text: "Hello", scope: "account" });
    expect(synthesize.mock.calls[0]?.[0]).toMatchObject({ voiceId: "account-voice" });
    await synthesizeVoice(deps, actor, { text: "Hello" });
    expect(synthesize.mock.calls[1]?.[0]).toMatchObject({ voiceId: "space-voice" });
  });

  it.each([
    ["VOICE_OUT_OF_CREDIT", 402],
    ["VOICE_KEY_REJECTED", 403],
    [undefined, 403],
  ] as const)("answers %s from the provider with HTTP %i and a warning", async (code, status) => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    const synthesize = vi
      .fn()
      .mockRejectedValue(
        new VoiceAccountError(code, "Fish Audio says this account is out of credit."),
      );
    vi.spyOn(adapters, "createVoiceProvider").mockReturnValue({ synthesize } as never);
    const prisma = {
      spaceSettingOverride: { findUnique: vi.fn().mockResolvedValue(null) },
      userVoicePreference: {
        findFirst: vi.fn().mockResolvedValue({
          isDefault: true,
          voiceId: "voice-1",
          speechModel: null,
          credential: {
            id: "cred-1",
            userId: actor.userId,
            provider: "fish-audio",
            secretId: "secret-1",
            createdAt: new Date(0),
            updatedAt: new Date(0),
          },
        }),
      },
      secret: {
        findFirst: vi.fn().mockResolvedValue({ id: "secret-1", ciphertext: "cipher" }),
      },
    };
    const deps = {
      prisma,
      secrets: { load: vi.fn().mockReturnValue("fish-key"), put: vi.fn() },
    } as unknown as VoiceDeps;
    const app = new Hono();
    mountVoiceHttpRoutes(app, deps, async () => actor);

    const response = await app.request("/api/voice/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Hello" }),
    });

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({
      error: "Fish Audio says this account is out of credit.",
      code,
    });
    expect(sink.events.map((event) => event.level)).toEqual(["warn"]);
    installLogger(createLogger({ service: "rakazo-api", level: "off", sinks: [] }));
  });

  describe("with a connection linked to the model connection", () => {
    const linkedPreference = {
      isDefault: true,
      voiceId: "eve",
      speechModel: null,
      credential: {
        id: "cred-1",
        userId: actor.userId,
        provider: "xai",
        secretId: "voice-secret",
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    };
    const voicePrisma = {
      spaceSettingOverride: { findUnique: vi.fn().mockResolvedValue(null) },
      userVoicePreference: { findFirst: vi.fn().mockResolvedValue(linkedPreference) },
    };

    it("speaks with the model connection's key", async () => {
      const synthesize = vi
        .fn()
        .mockResolvedValue({ bytes: new Uint8Array(), mimeType: "audio/mpeg" });
      vi.spyOn(adapters, "createVoiceProvider").mockReturnValue({ synthesize } as never);
      const deps = modelConnectionDeps(
        {
          "voice-secret": adapters.MODEL_CONNECTION_VOICE_SECRET,
          "model-secret": "xai-model-key",
        },
        voicePrisma,
      ) as unknown as VoiceDeps;

      await synthesizeVoice(deps, actor, { text: "Hello" });

      expect(synthesize.mock.calls[0]?.[0]).toMatchObject({
        apiKey: "xai-model-key",
        voiceId: "eve",
      });
    });

    it("asks to reconnect the model provider once that connection is gone", async () => {
      const synthesize = vi.fn();
      vi.spyOn(adapters, "createVoiceProvider").mockReturnValue({ synthesize } as never);
      const deps = modelConnectionDeps(
        { "voice-secret": adapters.MODEL_CONNECTION_VOICE_SECRET },
        voicePrisma,
        [],
      ) as unknown as VoiceDeps;
      const app = new Hono();
      mountVoiceHttpRoutes(app, deps, async () => actor);

      const response = await app.request("/api/voice/speak", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Hello" }),
      });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: "Connect xAI in Models settings.",
      });
      expect(synthesize).not.toHaveBeenCalled();
    });
  });
});

describe("voiceCredentialPlaintext", () => {
  it("keeps a hosted provider's key as the secret and requires one", () => {
    expect(voiceCredentialPlaintext({ provider: "openai", plaintext: "sk-test-key" })).toBe(
      "sk-test-key",
    );
    expect(() => voiceCredentialPlaintext({ provider: "openai", plaintext: "  " })).toThrow(
      "Enter an API key.",
    );
  });

  it("links a blank key to the model connection only where the provider allows it", () => {
    expect(voiceCredentialPlaintext({ provider: "xai", plaintext: "  " })).toBe(
      adapters.MODEL_CONNECTION_VOICE_SECRET,
    );
    expect(voiceCredentialPlaintext({ provider: "xai", plaintext: "xai-test-key" })).toBe(
      "xai-test-key",
    );
    expect(() => voiceCredentialPlaintext({ provider: "xai", plaintext: "short" })).toThrow(
      "Enter an API key.",
    );
    expect(() => voiceCredentialPlaintext({ provider: "openai", plaintext: "" })).toThrow(
      "Enter an API key.",
    );
  });

  it("ignores any pasted key for a keyless provider", () => {
    expect(voiceCredentialPlaintext({ provider: "macos", plaintext: "" })).toBe("macos");
    expect(voiceCredentialPlaintext({ provider: "macos", plaintext: "sk-test-key" })).toBe("macos");
  });

  it("stores a self-hosted server's address and models without a key", () => {
    const plaintext = voiceCredentialPlaintext({
      provider: "openai-compatible",
      allowPrivateEndpoint: true,
      plaintext: "",
      baseUrl: "http://100.64.0.10:8810",
      ttsModel: "kokoro",
    });
    expect(JSON.parse(plaintext)).toEqual({
      kind: "openai_compatible",
      baseUrl: "http://100.64.0.10:8810/v1",
      ttsModel: "kokoro",
      sttModel: adapters.DEFAULT_COMPATIBLE_STT_MODEL,
    });
  });

  it("keeps the stored key when reconnecting to the same server with the key left blank", () => {
    const previousPlaintext = serializeAsOwner({
      baseUrl: "http://100.64.0.10:8810",
      apiKey: "local-test-key",
    });
    const plaintext = voiceCredentialPlaintext({
      provider: "openai-compatible",
      allowPrivateEndpoint: true,
      plaintext: "",
      baseUrl: "http://100.64.0.10:8810/v1",
      previousPlaintext,
    });
    expect(JSON.parse(plaintext)).toMatchObject({ apiKey: "local-test-key" });
  });

  it("rejects a public server address as a bad request", () => {
    vi.stubEnv("RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC", "0");
    try {
      expect(() =>
        voiceCredentialPlaintext({
          provider: "openai-compatible",
          allowPrivateEndpoint: true,
          plaintext: "",
          baseUrl: "https://speech.example.com",
        }),
      ).toThrow(/Public model endpoints are disabled/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("voiceCredentialServer", () => {
  const plaintext = serializeAsOwner({
    baseUrl: "http://100.64.0.10:8810",
    apiKey: "local-test-key",
    ttsModel: "kokoro",
  });

  function deps(
    load: () => string,
    findFirst = vi.fn().mockResolvedValue({ id: "s", ciphertext: "c" }),
  ) {
    return {
      prisma: { secret: { findFirst } },
      secrets: { load: vi.fn(load), put: vi.fn() },
    } as unknown as VoiceDeps;
  }

  it("shows the address and models but never the key", async () => {
    const server = await voiceCredentialServer(
      deps(() => plaintext),
      actor,
      { provider: "openai-compatible", secretId: "secret-1" },
    );
    expect(server).toEqual({
      endpoint: "http://100.64.0.10:8810/v1",
      ttsModel: "kokoro",
      sttModel: adapters.DEFAULT_COMPATIBLE_STT_MODEL,
    });
    const output = toVoiceCredential({
      id: "cred-1",
      provider: "openai-compatible",
      isDefault: true,
      voiceId: "af_heart",
      server,
    });
    expect(JSON.stringify(output)).not.toContain("local-test-key");
    expect(output).not.toHaveProperty("apiKey");
  });

  it("does not decrypt hosted keys and survives an unreadable or unreachable secret", async () => {
    const hosted = deps(() => "sk-test-key");
    expect(
      await voiceCredentialServer(hosted, actor, { provider: "openai", secretId: "secret-1" }),
    ).toBeUndefined();
    expect(hosted.secrets.load).not.toHaveBeenCalled();
    const row = { provider: "openai-compatible", secretId: "secret-1" };
    const broken = deps(() => {
      throw new Error("bad ciphertext");
    });
    expect(await voiceCredentialServer(broken, actor, row)).toBeUndefined();
    const dbDown = deps(() => plaintext, vi.fn().mockRejectedValue(new Error("db down")));
    expect(await voiceCredentialServer(dbDown, actor, row)).toBeUndefined();
  });
});

describe("voiceCredentialHasKey", () => {
  const linked = { provider: "xai", secretId: "voice-secret" };
  const depsWith = (plaintexts: Record<string, string>) => {
    const deps = modelConnectionDeps(plaintexts);
    return { deps: deps as unknown as VoiceDeps, load: deps.secrets.load, raw: deps };
  };

  it("is false only for a connection linked to the model connection", async () => {
    const link = depsWith({ "voice-secret": adapters.MODEL_CONNECTION_VOICE_SECRET });
    expect(await voiceCredentialHasKey(link.deps, actor, linked)).toBe(false);
    const keyed = depsWith({ "voice-secret": "xai-test-key" });
    expect(await voiceCredentialHasKey(keyed.deps, actor, linked)).toBe(true);
  });

  it("does not decrypt other providers' keys and counts an unreadable secret as a key", async () => {
    const hosted = depsWith({ "voice-secret": adapters.MODEL_CONNECTION_VOICE_SECRET });
    expect(
      await voiceCredentialHasKey(hosted.deps, actor, {
        provider: "openai",
        secretId: "voice-secret",
      }),
    ).toBe(true);
    expect(hosted.load).not.toHaveBeenCalled();

    const broken = depsWith({ "voice-secret": adapters.MODEL_CONNECTION_VOICE_SECRET });
    broken.load.mockImplementation(() => {
      throw new Error("bad ciphertext");
    });
    expect(await voiceCredentialHasKey(broken.deps, actor, linked)).toBe(true);
    const missing = depsWith({});
    expect(await voiceCredentialHasKey(missing.deps, actor, linked)).toBe(true);
    const dbDown = depsWith({ "voice-secret": adapters.MODEL_CONNECTION_VOICE_SECRET });
    dbDown.raw.prisma.secret.findFirst.mockRejectedValue(new Error("db down"));
    expect(await voiceCredentialHasKey(dbDown.deps, actor, linked)).toBe(true);
  });
});

describe("accountVoiceCatalog", () => {
  async function catalogFor(modelCredentials: Array<typeof xaiModelCredential>) {
    const deps = modelConnectionDeps({}, {}, modelCredentials) as unknown as VoiceDeps;
    const catalog = await accountVoiceCatalog(deps, actor);
    return {
      ids: catalog.map((entry) => entry.id),
      linkable: catalog.flatMap((entry) =>
        "modelConnection" in entry ? [[entry.id, entry.modelConnection]] : [],
      ),
    };
  }

  it("offers the model connection only for a provider the account is connected to", async () => {
    const connected = await catalogFor([xaiModelCredential]);
    expect(connected.linkable).toEqual([["xai", true]]);

    for (const credentials of [[], [{ ...xaiModelCredential, provider: "openai" }]]) {
      const other = await catalogFor(credentials);
      expect(other.ids).toContain("xai");
      expect(other.linkable).toEqual([]);
    }
  });
});

describe("voiceChoicesChanged", () => {
  const first = serializeAsOwner({
    baseUrl: "http://100.64.0.10:8810",
  });
  const sameWithKey = serializeAsOwner({
    baseUrl: "http://100.64.0.10:8810/v1",
    apiKey: "local-test-key",
  });
  const otherModel = serializeAsOwner({
    baseUrl: "http://100.64.0.10:8810",
    ttsModel: "kokoro",
  });
  const otherServer = serializeAsOwner({
    baseUrl: "http://100.64.0.11:8880",
  });

  it("drops saved voices only when the server or speech model changes", () => {
    expect(voiceChoicesChanged(undefined, first)).toBe(false);
    expect(voiceChoicesChanged(first, sameWithKey)).toBe(false);
    expect(voiceChoicesChanged(first, otherModel)).toBe(true);
    expect(voiceChoicesChanged(first, otherServer)).toBe(true);
    expect(voiceChoicesChanged("sk-hosted-key", "sk-other-key")).toBe(false);
  });
});

describe("persistVoiceCredential", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    {
      change: "server",
      previous: { baseUrl: "http://100.64.0.10:8810" },
      next: { baseUrl: "http://100.64.0.11:8880" },
    },
    {
      change: "speech model",
      previous: { baseUrl: "http://100.64.0.10:8810", ttsModel: "old-model" },
      next: { baseUrl: "http://100.64.0.10:8810", ttsModel: "new-model" },
    },
  ])(
    "re-picks voices for every copy when the self-hosted $change changes",
    async ({ previous: before, next }) => {
      for (const scope of ["account", "space"] as const) {
        vi.restoreAllMocks();
        const previous = serializeAsOwner(before);
        vi.spyOn(adapters, "createVoiceProvider").mockReturnValue({
          verify: vi.fn().mockResolvedValue({ ok: true }),
          listVoices: vi.fn().mockResolvedValue([
            { id: "bm_george", label: "George" },
            { id: "af_sky", label: "Sky" },
          ]),
        } as never);
        vi.spyOn(db, "findVoiceCredential").mockResolvedValue({
          id: "cred-1",
          secretId: "old-secret",
          provider: "openai-compatible",
        } as never);
        const select = vi.spyOn(db, "selectVoicePreference").mockResolvedValue(undefined as never);
        vi.spyOn(db, "runAsSystemInTransaction").mockImplementation(
          async (_tx, _reason, fn) => fn() as never,
        );
        vi.spyOn(db, "deleteUnreferencedCredentialSecret").mockResolvedValue(undefined as never);
        const savedPreference = { voiceId: "af_heart", speechModel: null };
        const tx = {
          userVoiceCredential: {
            findFirst: vi.fn().mockResolvedValue({ id: "cred-1", secretId: "old-secret" }),
            update: vi.fn().mockResolvedValue({ id: "cred-1", provider: "openai-compatible" }),
          },
          secret: { create: vi.fn().mockResolvedValue({ id: "new-secret" }) },
          spaceSettingOverride: {
            findUnique: vi.fn().mockResolvedValue(scope === "space" ? { setting: "voice" } : null),
          },
          userVoicePreference: {
            findUnique: vi.fn().mockResolvedValue(savedPreference),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
          spaceVoicePreference: {
            findUnique: vi.fn().mockResolvedValue(savedPreference),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
          $queryRaw: vi.fn().mockResolvedValue([{ locked: 1 }]),
        };
        const deps = {
          env: { mcpAllowPrivateEndpoint: true },
          prisma: {
            deploymentSettings: {
              findUnique: vi.fn().mockResolvedValue({ ownerUserId: actor.userId }),
            },
            secret: {
              findFirst: vi.fn().mockResolvedValue({ id: "old-secret", ciphertext: "c" }),
            },
            $transaction: vi.fn((run: (client: typeof tx) => unknown) => run(tx)),
          },
          secrets: {
            load: vi.fn().mockReturnValue(previous),
            put: vi.fn().mockResolvedValue({ id: "new-secret", ciphertext: "n" }),
          },
        } as unknown as VoiceDeps;

        const saved = await persistVoiceCredential(deps, actor, {
          provider: "openai-compatible",
          plaintext: "local-test-key",
          voiceId: "af_heart",
          ...next,
        });

        expect(saved.voiceId).toBe("bm_george");
        expect(JSON.stringify(saved)).not.toContain("local-test-key");
        expect(saved).not.toHaveProperty("apiKey");
        expect(saved).not.toHaveProperty("secretId");
        expect(select).toHaveBeenCalledWith(
          tx,
          { userId: actor.userId, spaceId: actor.spaceId, scope },
          "cred-1",
          "bm_george",
          null,
        );
        const stale = {
          userId: actor.userId,
          credentialId: "cred-1",
          voiceId: { notIn: ["bm_george", "af_sky"] },
        };
        // The account's voice moves unless it was the copy just saved.
        if (scope === "space") {
          expect(tx.userVoicePreference.updateMany).toHaveBeenCalledWith({
            where: stale,
            data: { voiceId: "bm_george" },
          });
        } else {
          expect(tx.userVoicePreference.updateMany).not.toHaveBeenCalled();
        }
        // Only Spaces with their own voice move; the rest follow the account.
        expect(tx.spaceVoicePreference.updateMany).toHaveBeenCalledWith({
          where: {
            ...stale,
            spaceMember: { settingOverrides: { some: { setting: "voice" } } },
            ...(scope === "space" ? { spaceId: { not: actor.spaceId } } : {}),
          },
          data: { voiceId: "bm_george" },
        });
      }
    },
  );

  describe("for a provider that can use the model connection", () => {
    function linkedDeps(modelCredentials = [xaiModelCredential]) {
      const tx = {
        userVoiceCredential: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "cred-1", provider: "xai" }),
        },
        secret: { create: vi.fn().mockResolvedValue({ id: "voice-secret" }) },
        spaceSettingOverride: { findUnique: vi.fn().mockResolvedValue(null) },
        $queryRaw: vi.fn().mockResolvedValue([{ locked: 1 }]),
      };
      const deps = modelConnectionDeps(
        { "model-secret": "xai-model-key" },
        { $transaction: vi.fn((run: (client: typeof tx) => unknown) => run(tx)) },
        modelCredentials,
      );
      return { deps: deps as unknown as VoiceDeps, put: deps.secrets.put };
    }

    function stubProvider() {
      const verify = vi.fn().mockResolvedValue({ ok: true });
      const listVoices = vi.fn().mockResolvedValue([{ id: "eve", label: "Eve" }]);
      vi.spyOn(adapters, "createVoiceProvider").mockReturnValue({ verify, listVoices } as never);
      vi.spyOn(db, "selectVoicePreference").mockResolvedValue(undefined as never);
      return { verify, listVoices };
    }

    it("checks a blank key against the model connection but stores only the link", async () => {
      const { verify, listVoices } = stubProvider();
      const { deps, put } = linkedDeps();

      const saved = await persistVoiceCredential(deps, actor, { provider: "xai", plaintext: "" });

      expect(verify).toHaveBeenCalledWith("xai-model-key", expect.anything());
      expect(listVoices).toHaveBeenCalledWith("xai-model-key", expect.anything());
      expect(put).toHaveBeenCalledWith(adapters.MODEL_CONNECTION_VOICE_SECRET, expect.anything());
      expect(JSON.stringify(put.mock.calls)).not.toContain("xai-model-key");
      expect(saved).toMatchObject({ provider: "xai", hasKey: false, voiceId: "eve" });
    });

    it("uses a key the user enters instead of the model connection", async () => {
      const { verify } = stubProvider();
      const { deps, put } = linkedDeps();

      const saved = await persistVoiceCredential(deps, actor, {
        provider: "xai",
        plaintext: "xai-own-key",
      });

      expect(verify).toHaveBeenCalledWith("xai-own-key", expect.anything());
      expect(put).toHaveBeenCalledWith("xai-own-key", expect.anything());
      expect(saved.hasKey).toBe(true);
    });

    it("asks to connect the model provider first when there is no model connection", async () => {
      const { verify } = stubProvider();
      const { deps, put } = linkedDeps([]);

      await expect(
        persistVoiceCredential(deps, actor, { provider: "xai", plaintext: "" }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Connect xAI in Models settings." });
      expect(verify).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
    });

    it("explains a model connection that fails to refresh instead of failing silently", async () => {
      const { verify } = stubProvider();
      const { deps, put } = linkedDeps();
      vi.spyOn(adapters, "resolveVoiceKey").mockRejectedValueOnce(new Error("refresh timed out"));

      await expect(
        persistVoiceCredential(deps, actor, { provider: "xai", plaintext: "" }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "Couldn't use the xAI connection from Models. Try again.",
      });
      expect(verify).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
    });

    it("asks for a key when xAI refuses the model connection, not to check a key never typed", async () => {
      const { verify } = stubProvider();
      verify.mockResolvedValueOnce({
        ok: false,
        message: "xAI rejected that key.",
        code: "VOICE_KEY_REJECTED",
      });
      const { deps, put } = linkedDeps();

      await expect(
        persistVoiceCredential(deps, actor, { provider: "xai", plaintext: "" }),
      ).rejects.toMatchObject({
        message: "xAI didn't accept the Models connection for voice. Paste an API key.",
      });
      expect(put).not.toHaveBeenCalled();
    });

    it.each([
      {
        name: "spent credit",
        message: "You have run out of credits or need a Grok subscription",
        code: "VOICE_OUT_OF_CREDIT" as const,
      },
      { name: "a rate limit", message: "xAI is rate-limiting this account." },
      { name: "an outage", message: "checking that key failed (503)" },
    ])("keeps xAI's own words for $name", async ({ message, code }) => {
      const { verify } = stubProvider();
      verify.mockResolvedValueOnce({ ok: false, message, code });
      const { deps } = linkedDeps();

      await expect(
        persistVoiceCredential(deps, actor, { provider: "xai", plaintext: "" }),
      ).rejects.toMatchObject({ message });
    });
  });
});

it("refuses a private speech server for a user who is not the deployment owner", async () => {
  const verify = vi.fn();
  vi.spyOn(adapters, "createVoiceProvider").mockReturnValue({ verify } as never);
  try {
    await expect(
      persistVoiceCredential(
        {
          prisma: {
            userVoiceCredential: { findFirst: vi.fn().mockResolvedValue(null) },
            deploymentSettings: { findUnique: vi.fn().mockResolvedValue({ ownerUserId: "owner" }) },
          },
        } as unknown as VoiceDeps,
        actor,
        { provider: "openai-compatible", plaintext: "", baseUrl: "http://127.0.0.1:8880" },
      ),
    ).rejects.toThrow(adapters.PRIVATE_MODEL_ENDPOINT_MESSAGE);
    expect(verify).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});

it.each([
  "http://169.254.169.254",
  "http://169.254.1.2",
  "http://[fd00:ec2::254]",
  "http://[fe80::1]",
  "http://metadata.google.internal",
])("refuses connecting a metadata or link-local speech server: %s", async (baseUrl) => {
  await expect(
    persistVoiceCredential(
      {
        prisma: { userVoiceCredential: { findFirst: vi.fn().mockResolvedValue(null) } },
      } as unknown as VoiceDeps,
      actor,
      {
        provider: "openai-compatible",
        plaintext: "",
        baseUrl,
      },
    ),
  ).rejects.toThrow(/blocked metadata or link-local/);
});

describe("transcribeInboundVoice", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const owner = { userId: "user-1", spaceId: "space-1" };

  function deps(
    provider: string,
    overrides: { preference?: unknown | null; load?: () => string } = {},
  ) {
    return {
      prisma: {
        spaceSettingOverride: { findUnique: vi.fn().mockResolvedValue(null) },
        userVoicePreference: {
          findFirst: vi.fn().mockResolvedValue(
            overrides.preference === undefined
              ? {
                  isDefault: true,
                  voiceId: "voice-1",
                  speechModel: null,
                  credential: {
                    id: "cred-1",
                    userId: owner.userId,
                    provider,
                    secretId: "secret-1",
                    createdAt: new Date(0),
                    updatedAt: new Date(0),
                  },
                }
              : overrides.preference,
          ),
        },
        secret: { findFirst: vi.fn().mockResolvedValue({ id: "secret-1", ciphertext: "c" }) },
      },
      secrets: {
        load: vi.fn().mockImplementation(async () => overrides.load?.() ?? "key"),
        put: vi.fn(),
      },
    } as unknown as VoiceDeps;
  }

  it("returns the transcript from the owner's default voice provider", async () => {
    const transcribe = vi.fn().mockResolvedValue({ text: "spoken words " });
    vi.spyOn(adapters, "createVoiceProvider").mockReturnValue({ transcribe } as never);

    await expect(
      transcribeInboundVoice(deps("openai"), owner, {
        audio: new Uint8Array([1, 2]),
        mimeType: "audio/ogg",
      }),
    ).resolves.toBe("spoken words ");
    expect(transcribe).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: expect.any(Uint8Array),
        mimeType: "audio/ogg",
        apiKey: "key",
      }),
      expect.objectContaining({ spaceId: "space-1", userId: "user-1" }),
    );
  });

  it("passes the caller's cancel signal to the provider", async () => {
    const transcribe = vi.fn().mockResolvedValue({ text: "spoken words" });
    vi.spyOn(adapters, "createVoiceProvider").mockReturnValue({ transcribe } as never);
    const controller = new AbortController();

    await transcribeInboundVoice(deps("openai"), owner, {
      audio: new Uint8Array([1, 2]),
      mimeType: "audio/ogg",
      signal: controller.signal,
    });
    expect(transcribe).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("returns null when the owner has no default voice credential", async () => {
    const create = vi.spyOn(adapters, "createVoiceProvider").mockReturnValue({} as never);

    await expect(
      transcribeInboundVoice(deps("openai", { preference: null }), owner, {
        audio: new Uint8Array([1]),
        mimeType: "audio/ogg",
      }),
    ).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("returns null when the provider does not transcribe", async () => {
    vi.spyOn(adapters, "createVoiceProvider").mockReturnValue({ synthesize: vi.fn() } as never);

    await expect(
      transcribeInboundVoice(deps("cartesia"), owner, {
        audio: new Uint8Array([1]),
        mimeType: "audio/ogg",
      }),
    ).resolves.toBeNull();
  });

  it("skips oversize audio without calling the provider", async () => {
    const transcribe = vi.fn();
    vi.spyOn(adapters, "createVoiceProvider").mockReturnValue({ transcribe } as never);

    await expect(
      transcribeInboundVoice(deps("openai"), owner, {
        audio: new Uint8Array(adapters.MAX_TRANSCRIBE_BYTES + 1),
        mimeType: "audio/ogg",
      }),
    ).resolves.toBeNull();
    expect(transcribe).not.toHaveBeenCalled();
  });
});

describe("linked voice failures", () => {
  it("hides refresh and provider response text", async () => {
    const sink = createTestSink();
    installLogger(createLogger({ service: "test", level: "warn", sinks: [sink] }));
    try {
      await expect(
        withVoiceConnection("xai", true, async () => {
          throw new Error("private provider response");
        }),
      ).rejects.toThrow("Couldn't use the xAI connection from Models. Try again.");
      expect(JSON.stringify(sink.events)).not.toContain("private provider response");
    } finally {
      installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
    }
  });

  it("offers disconnect and a key when a linked bearer is rejected", async () => {
    await expect(
      withVoiceConnection("xai", true, async () => {
        throw new VoiceAccountError("VOICE_KEY_REJECTED", "check the key");
      }),
    ).rejects.toMatchObject({
      code: "VOICE_KEY_REJECTED",
      message:
        "xAI didn't accept the Models connection for voice. Disconnect and paste an API key.",
    });
  });
});
