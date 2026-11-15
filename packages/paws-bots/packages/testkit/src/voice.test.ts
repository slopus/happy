import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SCRIPTED_MPEG, SCRIPTED_TRANSCRIPT, SCRIPTED_VOICE_ID } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BotIntroHarness } from "./discard-bot-intro.js";
import { discardBotIntroFromCreate } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";
import { asSystem } from "./system-db.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeVoice = hasDb ? describe : describe.skip;
let botIntroHarness: BotIntroHarness | undefined;

describeVoice("voice credentials and speech HTTP", () => {
  let app: App;
  let prisma: PrismaClient;
  let stop: () => Promise<void>;
  const stamp = Date.now();
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-voice-"));

  beforeAll(async () => {
    const { createApp } = await import("@rakazo/api/app");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
    });
    app = handles.app;
    prisma = asSystem(handles.prisma);
    stop = handles.stop;
    botIntroHarness = handles;
  });

  afterAll(async () => {
    await stop?.();
  });

  it("connects a scripted key, speaks, and transcribes without leaking the secret", async () => {
    const cookie = await signup(app, `voice-${stamp}@rakazo.test`, "Voice User");
    const other = await signup(app, `voice-other-${stamp}@rakazo.test`, "Other Voice");

    const before = await rpc<{ ready: boolean; utterances: string[] }>(
      app,
      cookie,
      "voice/prepare",
      { text: "Hello there." },
    );
    expect(before).toEqual({ ready: false, utterances: [] });

    const catalog = await rpc<Array<{ id: string }>>(app, cookie, "voice/catalog");
    expect(catalog.map((entry) => entry.id)).toContain("scripted");

    const connected = await rpc<{ hasKey: boolean; provider: string; voiceId: string }>(
      app,
      cookie,
      "voice/connect",
      { provider: "scripted", apiKey: "fake-scripted-voice-key" },
    );
    expect(connected.hasKey).toBe(true);
    expect(connected.provider).toBe("scripted");
    expect(connected.voiceId).toBe(SCRIPTED_VOICE_ID);
    expect(JSON.stringify(connected)).not.toContain("fake-scripted-voice-key");

    const credentials = await rpc<Array<{ hasKey: boolean; voiceId: string }>>(
      app,
      cookie,
      "voice/credentials",
    );
    expect(credentials).toEqual([
      expect.objectContaining({ hasKey: true, voiceId: SCRIPTED_VOICE_ID }),
    ]);
    expect(JSON.stringify(credentials)).not.toContain("fake-scripted-voice-key");

    const prepared = await rpc<{ ready: boolean; utterances: string[] }>(
      app,
      cookie,
      "voice/prepare",
      { text: "Hello there. How are you?" },
    );
    expect(prepared.ready).toBe(true);
    expect(prepared.utterances.length).toBeGreaterThan(0);

    const spoken = await app.request("/api/voice/speak", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: "http://127.0.0.1:5173",
      },
      body: JSON.stringify({ text: "Hello there." }),
    });
    expect(spoken.status).toBe(200);
    expect(spoken.headers.get("content-type")).toContain("audio/mpeg");
    expect(Buffer.from(await spoken.arrayBuffer())).toEqual(Buffer.from(SCRIPTED_MPEG));

    const transcribed = await app.request("/api/voice/transcribe", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: "http://127.0.0.1:5173",
      },
      body: JSON.stringify({
        audioBase64: Buffer.from("noise").toString("base64"),
        mimeType: "audio/webm",
      }),
    });
    expect(transcribed.status).toBe(200);
    expect(await transcribed.json()).toEqual({ text: SCRIPTED_TRANSCRIPT });

    const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Speaker",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    const stolen = await raw(app, other, "voice/prepare", {
      text: "stolen",
      botId: bot.id,
    });
    expect(stolen.status).toBeGreaterThanOrEqual(400);

    const unauth = await app.request("/api/voice/speak", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(unauth.status).toBe(401);
  });

  it("disconnects the actor credential and leaves another user's key in place", async () => {
    const cookie = await signup(app, `voice-disconnect-${stamp}@rakazo.test`, "Voice Disconnect");
    const other = await signup(
      app,
      `voice-disconnect-other-${stamp}@rakazo.test`,
      "Other Voice Disconnect",
    );
    const me = await rpc<{ userId: string }>(app, cookie, "me");

    await rpc(app, cookie, "voice/connect", {
      provider: "scripted",
      apiKey: "fake-scripted-voice-key",
    });
    const stored = await prisma.userVoiceCredential.findFirstOrThrow({
      where: { userId: me.userId, provider: "scripted" },
    });

    await expect(rpc(app, other, "voice/disconnect", { provider: "scripted" })).resolves.toEqual({
      ok: true,
    });
    await expect(
      prisma.userVoiceCredential.findUnique({ where: { id: stored.id } }),
    ).resolves.toMatchObject({ id: stored.id });
    await expect(
      prisma.secret.findUnique({ where: { id: stored.secretId } }),
    ).resolves.toMatchObject({ id: stored.secretId });

    await expect(rpc(app, cookie, "voice/disconnect", { provider: "scripted" })).resolves.toEqual({
      ok: true,
    });
    await expect(
      rpc<Array<{ provider: string }>>(app, cookie, "voice/credentials"),
    ).resolves.toEqual([]);
    await expect(
      prisma.userVoiceCredential.findUnique({ where: { id: stored.id } }),
    ).resolves.toBeNull();
    await expect(
      prisma.spaceVoicePreference.count({ where: { credentialId: stored.id } }),
    ).resolves.toBe(0);
    await expect(
      prisma.userVoicePreference.count({ where: { credentialId: stored.id } }),
    ).resolves.toBe(0);
    await expect(prisma.secret.findUnique({ where: { id: stored.secretId } })).resolves.toBeNull();

    const prepared = await rpc<{ ready: boolean }>(app, cookie, "voice/prepare", {
      text: "Hello there.",
    });
    expect(prepared.ready).toBe(false);

    await expect(rpc(app, cookie, "voice/disconnect", { provider: "scripted" })).resolves.toEqual({
      ok: true,
    });
  });
});

async function signup(app: App, email: string, name: string) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ email, password: "test-password-123", name }),
  });
  expect(response.status).toBeLessThan(400);
  return sessionCookieHeader(response);
}

async function rpc<T>(app: App, cookie: string, proc: string, body: unknown = {}): Promise<T> {
  const res = await raw(app, cookie, proc, body);
  const text = await res.text();
  const parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (res.status >= 400 || parsed.error) {
    throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? text}`);
  }
  return discardBotIntroFromCreate(botIntroHarness, cookie, proc, parsed.json as T);
}

async function raw(app: App, cookie: string, proc: string, body: unknown) {
  return app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ json: body }),
  });
}
