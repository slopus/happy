import { once } from "node:events";
import { createServer } from "node:http";
import { VoiceAccountError } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_VOICE_JSON_BYTES,
  readVoiceJson,
  speechUploadName,
  verifyVoiceHttpGet,
  voiceAccountIssue,
  voiceDeadline,
  voiceLanguageHint,
  voiceRequestError,
} from "./voice-http.js";

describe("voiceDeadline", () => {
  it("aborts when the client signal aborts", () => {
    const client = new AbortController();
    const combined = voiceDeadline(client.signal, 20_000);
    expect(combined.aborted).toBe(false);
    client.abort();
    expect(combined.aborted).toBe(true);
  });

  it("aborts when the deadline elapses even if the client stays connected", async () => {
    const combined = voiceDeadline(new AbortController().signal, 1);
    await new Promise<void>((resolve, reject) => {
      const guard = setTimeout(() => reject(new Error("deadline did not abort")), 1_000);
      combined.addEventListener(
        "abort",
        () => {
          clearTimeout(guard);
          resolve();
        },
        { once: true },
      );
    });
    expect(combined.aborted).toBe(true);
  });
});

describe("speechUploadName", () => {
  it("keeps webm recordings as webm even when they name an opus codec", () => {
    expect(speechUploadName("audio/webm;codecs=opus")).toBe("speech.webm");
  });

  it("maps Firefox ogg capture to an ogg filename", () => {
    expect(speechUploadName("audio/ogg; codecs=opus")).toBe("speech.ogg");
  });
});

describe("verifyVoiceHttpGet", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["pending", "rejecting"])("does not await %s success-body cleanup", async (mode) => {
    const cancel = vi.fn(() =>
      mode === "pending"
        ? new Promise<void>(() => undefined)
        : Promise.reject(new Error("cleanup failed")),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }))));
    await expect(
      verifyVoiceHttpGet({
        url: "https://api.example/voices",
        headers: {},
        signal: new AbortController().signal,
        provider: "Example",
      }),
    ).resolves.toEqual({ ok: true });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("closes a successful streaming response without waiting for the deadline", async () => {
    let closed = false;
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
      res.on("close", () => {
        closed = true;
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test address");
    const controller = new AbortController();
    try {
      await expect(
        verifyVoiceHttpGet({
          url: `http://127.0.0.1:${address.port}/voices`,
          headers: {},
          signal: controller.signal,
          provider: "Example",
        }),
      ).resolves.toEqual({ ok: true });
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 1000 });
    } finally {
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("returns ok when the provider accepts the key", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await expect(
      verifyVoiceHttpGet({
        url: "https://api.example/voices",
        headers: { authorization: "Bearer key" },
        signal: new AbortController().signal,
        provider: "Example",
      }),
    ).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledOnce();
    const [, init] = fetch.mock.calls[0]!;
    expect(init.method).toBeUndefined();
    expect(init.headers).toEqual({ authorization: "Bearer key" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns the key-rejected message without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 401 })));

    await expect(
      verifyVoiceHttpGet({
        url: "https://api.example/voices",
        headers: {},
        signal: new AbortController().signal,
        provider: "ElevenLabs",
      }),
    ).resolves.toEqual({
      ok: false,
      message: "ElevenLabs rejected that key. Check the key and that it has speech permissions.",
      code: "VOICE_KEY_REJECTED",
    });
  });

  it("includes the provider detail when checking the key fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ detail: "voice quota" }), { status: 500 }),
        ),
    );

    await expect(
      verifyVoiceHttpGet({
        url: "https://api.example/voices",
        headers: {},
        signal: new AbortController().signal,
        provider: "OpenAI",
      }),
    ).resolves.toEqual({
      ok: false,
      message: "checking that key failed: voice quota",
    });
  });

  it("returns the unreachable message when fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));

    await expect(
      verifyVoiceHttpGet({
        url: "https://api.example/voices",
        headers: {},
        signal: new AbortController().signal,
        provider: "Cartesia",
      }),
    ).resolves.toEqual({
      ok: false,
      message: "Couldn't reach Cartesia to check that key. Check your connection.",
    });
  });
});

describe("readVoiceJson", () => {
  it("rejects an oversized provider response without waiting for cancellation", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { "content-length": String(MAX_VOICE_JSON_BYTES + 1) },
    });

    await expect(readVoiceJson(response)).rejects.toThrow("Voice response is too large.");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects malformed successful JSON when the caller requires a payload", async () => {
    await expect(readVoiceJson(new Response("not json"), { requireValid: true })).rejects.toThrow(
      "Voice provider returned invalid JSON.",
    );
  });

  it("keeps malformed error bodies optional", async () => {
    await expect(readVoiceJson(new Response("not json"))).resolves.toBeNull();
  });

  it("returns malformed text when the caller wants the raw error", async () => {
    await expect(
      readVoiceJson(new Response("upstream down"), { rawOnInvalid: true }),
    ).resolves.toBe("upstream down");
  });
});

describe("voiceAccountIssue", () => {
  it.each([
    ["Fish Audio or Cartesia spent credit", 402, { message: "Insufficient API credit." }],
    [
      "OpenAI insufficient quota",
      429,
      { error: { message: "You have no credits remaining.", code: "insufficient_quota" } },
    ],
    [
      "OpenAI spent credit without the quota code",
      429,
      { error: { message: "You have no credits remaining. Add credits to continue." } },
    ],
    [
      "OpenAI inactive billing",
      429,
      {
        error: {
          message: "Your account is not active, please check your billing details on our website.",
          code: "billing_not_active",
        },
      },
    ],
    ["ElevenLabs spent quota", 401, { detail: { status: "quota_exceeded", message: "Over" } }],
  ])("reads %s as out of credit", (_name, status, body) => {
    expect(voiceAccountIssue(status, body)).toBe("VOICE_OUT_OF_CREDIT");
  });

  it.each([
    ["a bare 401", 401, null],
    ["a 403", 403, { message: "Forbidden" }],
    [
      "an xAI permission refusal",
      403,
      { error: "The caller does not have permission to execute the specified operation" },
    ],
    ["ElevenLabs invalid key", 401, { detail: { status: "invalid_api_key", message: "Bad" } }],
  ])("reads %s as a rejected key", (_name, status, body) => {
    expect(voiceAccountIssue(status, body)).toBe("VOICE_KEY_REJECTED");
  });

  it("keeps a generic forbidden billing message classified as a rejected key", () => {
    expect(voiceAccountIssue(403, { error: "billing" })).toBe("VOICE_KEY_REJECTED");
  });

  it.each([
    ["a rate limit", 429, { error: { message: "Slow down", code: "rate_limit_exceeded" } }],
    [
      "an OpenAI per-minute limit",
      429,
      {
        error: {
          message:
            "Rate limit reached for tts-1 on requests per min (RPM). Please try again in 20s.",
          code: "rate_limit_exceeded",
        },
      },
    ],
    [
      "an ordinary validation error",
      400,
      { code: "Client specified an invalid argument", error: "voice_id is required" },
    ],
    ["a different provider invalid key response", 400, { error: "Incorrect API key" }],
    ["an outage", 503, { message: "Service unavailable" }],
    [
      "a missing ElevenLabs permission",
      401,
      { detail: { status: "missing_permissions", message: "Needs text_to_speech" } },
    ],
  ])("leaves %s unclassified", (_name, status, body) => {
    expect(voiceAccountIssue(status, body)).toBeUndefined();
  });

  it("raises account issues as VoiceAccountError and keeps the provider message", () => {
    const error = voiceRequestError(402, "Fish Audio", "speaking", null);
    expect(error).toBeInstanceOf(VoiceAccountError);
    expect(error).toMatchObject({
      code: "VOICE_OUT_OF_CREDIT",
      message: "Fish Audio says this account is out of credit.",
    });
    expect(voiceRequestError(503, "Fish Audio", "speaking", null)).not.toBeInstanceOf(
      VoiceAccountError,
    );
  });

  it("raises other refusals of the account without a code and keeps the provider message", () => {
    const permission = "The API key you used is missing the permission text_to_speech.";
    const error = voiceRequestError(401, "ElevenLabs", "speaking", {
      detail: { status: "missing_permissions", message: permission },
    });
    expect(error).toBeInstanceOf(VoiceAccountError);
    expect(error).toMatchObject({ code: undefined, message: permission });
    expect(voiceRequestError(400, "ElevenLabs", "speaking", null)).not.toBeInstanceOf(
      VoiceAccountError,
    );
  });
});

describe("voiceLanguageHint", () => {
  it("keeps the lowercase primary subtag of a valid language tag", () => {
    expect(voiceLanguageHint("pl")).toBe("pl");
    expect(voiceLanguageHint("es-ES")).toBe("es");
    expect(voiceLanguageHint(" PT-br ")).toBe("pt");
    expect(voiceLanguageHint("zh-Hant-TW")).toBe("zh");
  });

  it("omits values that are not language tags", () => {
    expect(voiceLanguageHint(undefined)).toBeUndefined();
    expect(voiceLanguageHint("")).toBeUndefined();
    expect(voiceLanguageHint("english")).toBeUndefined();
    expect(voiceLanguageHint("es_ES")).toBeUndefined();
  });
});
