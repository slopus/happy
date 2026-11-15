import { afterEach, describe, expect, it, vi } from "vitest";
import { PRIVATE_MODEL_ENDPOINT_MESSAGE } from "./openai-compatible-url.js";
import {
  DEFAULT_COMPATIBLE_STT_MODEL,
  DEFAULT_COMPATIBLE_TTS_MODEL,
  kokoroLangCode,
  OpenAiCompatibleVoiceProvider,
  openAiCompatibleVoiceServer,
  parseCompatibleVoiceList,
  parseOpenAiCompatibleVoiceSecret,
  serializeOpenAiCompatibleVoiceSecret,
} from "./openai-compatible-voice.js";

/** Fixtures save as the deployment owner, who may use local speech servers. */
const serializeAsOwner = (
  input: Parameters<typeof serializeOpenAiCompatibleVoiceSecret>[0],
  previous?: string,
) => serializeOpenAiCompatibleVoiceSecret(input, previous, { allowPrivate: true });

const ctx = {
  operationId: "voice",
  traceId: "voice",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

const keyless = serializeAsOwner({ baseUrl: "http://100.64.0.10:8810" });
const keyed = serializeAsOwner({
  baseUrl: "http://192.168.1.20:8880/v1",
  apiKey: "local-test-key",
  ttsModel: "kokoro",
  sttModel: "whisper-1",
});

function provider(fetchMock: ReturnType<typeof vi.fn>) {
  return new OpenAiCompatibleVoiceProvider({
    fetch: fetchMock as unknown as typeof fetch,
    allowPrivateEndpoint: true,
  });
}

function calledUrl(fetchMock: ReturnType<typeof vi.fn>, call = 0) {
  return String(fetchMock.mock.calls[call]?.[0]);
}

function calledInit(fetchMock: ReturnType<typeof vi.fn>, call = 0) {
  return fetchMock.mock.calls[call]?.[1] as RequestInit;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("serializeOpenAiCompatibleVoiceSecret", () => {
  it("refuses a private speech server unless private endpoints are allowed", async () => {
    expect(() =>
      serializeOpenAiCompatibleVoiceSecret({ baseUrl: "http://192.168.1.20:8880" }),
    ).toThrow(PRIVATE_MODEL_ENDPOINT_MESSAGE);
    const fetchMock = vi.fn();
    const denied = new OpenAiCompatibleVoiceProvider({
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(
      denied.synthesize({ text: "hi", voiceId: "af_heart", apiKey: keyed }, ctx),
    ).rejects.toThrow(PRIVATE_MODEL_ENDPOINT_MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("adds /v1 and fills the Kokoro and Whisper model defaults", () => {
    expect(parseOpenAiCompatibleVoiceSecret(keyless)).toEqual({
      kind: "openai_compatible",
      baseUrl: "http://100.64.0.10:8810/v1",
      ttsModel: DEFAULT_COMPATIBLE_TTS_MODEL,
      sttModel: DEFAULT_COMPATIBLE_STT_MODEL,
    });
    expect(openAiCompatibleVoiceServer(keyed)).toEqual({
      endpoint: "http://192.168.1.20:8880/v1",
      ttsModel: "kokoro",
      sttModel: "whisper-1",
    });
  });

  it("blocks public hosts, metadata hosts, and cleartext keys to public servers", () => {
    vi.stubEnv("RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC", "0");
    expect(() => serializeAsOwner({ baseUrl: "https://speech.example.com" })).toThrow(
      /Public model endpoints are disabled/,
    );
    expect(() => serializeAsOwner({ baseUrl: "http://169.254.169.254" })).toThrow(/blocked/);
    vi.stubEnv("RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC", "1");
    expect(() =>
      serializeAsOwner({
        baseUrl: "http://speech.example.com",
        apiKey: "local-test-key",
      }),
    ).toThrow(/must use HTTPS/);
  });

  it("rejects model ids that are not plain identifiers", () => {
    expect(() =>
      serializeAsOwner({
        baseUrl: "http://127.0.0.1:8810",
        ttsModel: "kokoro\nx-injected: 1",
      }),
    ).toThrow(/Speech model id is not valid/);
  });

  it("keeps the saved key and models on reconnect to the same server only", () => {
    const again = parseOpenAiCompatibleVoiceSecret(
      serializeAsOwner({ baseUrl: "http://192.168.1.20:8880" }, keyed),
    );
    expect(again).toMatchObject({
      apiKey: "local-test-key",
      ttsModel: "kokoro",
      sttModel: "whisper-1",
    });
    const moved = parseOpenAiCompatibleVoiceSecret(
      serializeAsOwner({ baseUrl: "http://192.168.1.21:8880" }, keyed),
    );
    expect(moved.apiKey).toBeUndefined();
    expect(moved.ttsModel).toBe(DEFAULT_COMPATIBLE_TTS_MODEL);
  });

  it("rejects a key that could break the Authorization header", () => {
    expect(() =>
      serializeAsOwner({
        baseUrl: "http://127.0.0.1:8810",
        apiKey: "abc\r\nx-injected: 1",
      }),
    ).toThrow("That API key has characters a key cannot contain.");
  });

  it("refuses an unreadable saved secret instead of sending it anywhere", () => {
    expect(() => parseOpenAiCompatibleVoiceSecret("sk-bare-key")).toThrow(/unreadable/);
    expect(openAiCompatibleVoiceServer("sk-bare-key")).toBeUndefined();
  });
});

describe("parseCompatibleVoiceList", () => {
  it("reads mlx-audio, Kokoro-FastAPI, and legacy string shapes", () => {
    expect(parseCompatibleVoiceList({ data: [{ id: "bf_emma", name: "bf_emma" }] })).toEqual([
      { id: "bf_emma", label: "Emma", description: "British English, female" },
    ]);
    expect(parseCompatibleVoiceList({ voices: [{ id: "am_adam", name: "am_adam" }] })[0]?.id).toBe(
      "am_adam",
    );
    expect(parseCompatibleVoiceList({ voices: ["zf_xiaobei"] })[0]).toEqual({
      id: "zf_xiaobei",
      label: "Xiaobei",
      description: "Mandarin Chinese, female",
    });
    expect(parseCompatibleVoiceList([{ id: "custom", name: "My Voice" }])).toEqual([
      { id: "custom", label: "My Voice" },
    ]);
  });

  it("keeps a server's voice list short: capped count and single-line names", () => {
    const many = Array.from({ length: 800 }, (_, index) => ({ id: `v${index}`, name: "x" }));
    expect(parseCompatibleVoiceList({ data: many })).toHaveLength(500);
    const [voice] = parseCompatibleVoiceList([{ id: "long", name: `a\nb${"c".repeat(300)}` }]);
    expect(voice?.label).toHaveLength(120);
    expect(voice?.label.startsWith("a b")).toBe(true);
  });

  it("puts af_heart first so it becomes the default voice, and drops junk", () => {
    const voices = parseCompatibleVoiceList({
      data: [{ id: "af_alloy" }, { id: 7 }, { id: "" }, { id: "af_heart" }, { id: "af_alloy" }],
    });
    expect(voices.map((voice) => voice.id)).toEqual(["af_heart", "af_alloy"]);
  });
});

describe("kokoroLangCode", () => {
  it("takes the language from Kokoro voice ids only", () => {
    expect(kokoroLangCode("af_heart")).toBe("a");
    expect(kokoroLangCode("jf_alpha")).toBe("j");
    expect(kokoroLangCode("alloy")).toBeUndefined();
    expect(kokoroLangCode("xf_unknown")).toBeUndefined();
  });
});

describe("OpenAiCompatibleVoiceProvider", () => {
  it("verifies against /models without an auth header when there is no key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"data":[]}'));
    await expect(provider(fetchMock).verify(keyless, ctx)).resolves.toEqual({ ok: true });
    expect(calledInit(fetchMock).redirect).toBe("error");
    expect(calledUrl(fetchMock)).toBe("http://100.64.0.10:8810/v1/models");
    expect(new Headers(calledInit(fetchMock).headers).has("authorization")).toBe(false);
  });

  it("falls back to the voice list when the server has no /models", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("Not Found", { status: 404 }))
      .mockResolvedValueOnce(new Response('{"voices":[]}'));
    await expect(provider(fetchMock).verify(keyed, ctx)).resolves.toEqual({ ok: true });
    expect(calledUrl(fetchMock, 1)).toBe("http://192.168.1.20:8880/v1/audio/voices?model=kokoro");
    expect(new Headers(calledInit(fetchMock, 1).headers).get("authorization")).toBe(
      "Bearer local-test-key",
    );
  });

  it("reports a rejected key and an unreachable server", async () => {
    const rejected = vi.fn().mockResolvedValue(new Response("{}", { status: 401 }));
    await expect(provider(rejected).verify(keyed, ctx)).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining("rejected that key"),
    });
    const down = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(provider(down).verify(keyless, ctx)).resolves.toEqual({
      ok: false,
      message: "Couldn't reach the speech server at http://100.64.0.10:8810.",
    });
  });

  it("reports only the status when the check fails, never the server's body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ detail: "internal admin token abc" }), { status: 500 }),
      );
    const result = await provider(fetchMock).verify(keyless, ctx);
    expect(result).toEqual({ ok: false, message: "Checking the speech server failed (500)" });
  });

  it("lists the server's voices and falls back to Kokoro voices without a list", async () => {
    const listed = vi
      .fn()
      .mockResolvedValue(new Response('{"data":[{"id":"am_michael","name":"am_michael"}]}'));
    expect(await provider(listed).listVoices(keyless, ctx)).toEqual([
      { id: "am_michael", label: "Michael", description: "American English, male" },
    ]);
    expect(calledInit(listed).redirect).toBe("error");
    expect(calledUrl(listed)).toBe(
      `http://100.64.0.10:8810/v1/audio/voices?model=${encodeURIComponent(DEFAULT_COMPATIBLE_TTS_MODEL)}`,
    );
    const missing = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }));
    const fallback = await provider(missing).listVoices(keyless, ctx);
    expect(fallback[0]).toEqual({
      id: "af_heart",
      label: "Heart",
      description: "American English, female",
    });
  });

  it("falls back to the standard OpenAI voices when the speech model is not Kokoro", async () => {
    const hosted = serializeAsOwner({
      baseUrl: "https://speech.example.test/api/v1",
      apiKey: "test-key-123",
      ttsModel: "openai/gpt-4o-mini-tts",
    });
    const missing = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }));
    const voices = await provider(missing).listVoices(hosted, ctx);
    expect(voices[0]?.id).toBe("alloy");
    expect(voices.some((voice) => voice.id === "af_heart")).toBe(false);
  });

  it("speaks MP3 with the saved model and the voice's Kokoro language", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } }),
      );
    const clip = await provider(fetchMock).synthesize(
      { text: "Hola", voiceId: "ef_dora", apiKey: keyed },
      ctx,
    );
    expect(clip).toEqual({ bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/mpeg" });
    expect(calledInit(fetchMock).redirect).toBe("error");
    expect(calledUrl(fetchMock)).toBe("http://192.168.1.20:8880/v1/audio/speech");
    expect(JSON.parse(String(calledInit(fetchMock).body))).toEqual({
      model: "kokoro",
      voice: "ef_dora",
      input: "Hola",
      response_format: "mp3",
      lang_code: "e",
    });
  });

  it("caps and flattens a long server error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: `line one\nline two ${"x".repeat(500)}` }), {
        status: 400,
      }),
    );
    const error = await provider(fetchMock)
      .synthesize({ text: "Hi", voiceId: "af_heart", apiKey: keyless }, ctx)
      .catch((caught: Error) => caught);
    expect((error as Error).message).toMatch(/^speaking failed: line one line two x+$/);
    expect((error as Error).message.length).toBeLessThan(200);
  });

  it("does not fall back to stock voices when the address is blocked", async () => {
    const fetchMock = vi.fn();
    const tampered = JSON.stringify({
      ...parseOpenAiCompatibleVoiceSecret(keyless),
      baseUrl: "http://169.254.169.254/v1",
    });
    await expect(provider(fetchMock).listVoices(tampered, ctx)).rejects.toThrow(/blocked/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a speech reply that is not MP3 audio", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response("<html>login</html>", { headers: { "content-type": "text/html" } }),
      );
    await expect(
      provider(fetchMock).synthesize({ text: "Hi", voiceId: "af_heart", apiKey: keyless }, ctx),
    ).rejects.toThrow("The speech server did not return MP3 audio.");
    const mp3 = vi
      .fn()
      .mockResolvedValue(
        new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mp3" } }),
      );
    await expect(
      provider(mp3).synthesize({ text: "Hi", voiceId: "af_heart", apiKey: keyless }, ctx),
    ).resolves.toMatchObject({ mimeType: "audio/mpeg" });
  });

  it("omits lang_code for voices that are not Kokoro ids", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mpeg" } }),
      );
    await provider(fetchMock).synthesize({ text: "Hi", voiceId: "alloy", apiKey: keyless }, ctx);
    expect(JSON.parse(String(calledInit(fetchMock).body))).not.toHaveProperty("lang_code");
  });

  it("surfaces the server's error detail when speaking fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ detail: "Model not found" }), { status: 400 }),
      );
    await expect(
      provider(fetchMock).synthesize({ text: "Hi", voiceId: "af_heart", apiKey: keyless }, ctx),
    ).rejects.toThrow("speaking failed: Model not found");
  });

  it.each(["speaking", "transcribing"])(
    "surfaces and sanitizes a nested server error when %s fails",
    async (operation) => {
      const detail = `Model fake-tts was not found\nlocal-test-key ${"x".repeat(200)}`;
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: { message: detail } }), { status: 404 }),
        );
      const voice = provider(fetchMock);
      const result =
        operation === "speaking"
          ? voice.synthesize({ text: "Hi", voiceId: "alloy", apiKey: keyed }, ctx)
          : voice.transcribe(
              { audio: new Uint8Array([1]), mimeType: "audio/webm", apiKey: keyed },
              ctx,
            );
      const error = await result.catch((caught: Error) => caught);
      expect((error as Error).message).toBe(
        `${operation} failed: ${`Model fake-tts was not found [redacted] ${"x".repeat(200)}`.slice(0, 160)}`,
      );
    },
  );

  it.each(["not JSON", "null", '{"error":{"message":42}}'])(
    "falls back to the status for an invalid error body: %s",
    async (body) => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status: 404 }));
      await expect(
        provider(fetchMock).synthesize({ text: "Hi", voiceId: "alloy", apiKey: keyless }, ctx),
      ).rejects.toThrow("speaking failed (404)");
    },
  );

  it("reads an insufficient_quota 429 as spent credit", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: { message: "No credits", code: "insufficient_quota" } }),
          { status: 429 },
        ),
      );
    await expect(
      provider(fetchMock).synthesize({ text: "Hi", voiceId: "af_heart", apiKey: keyless }, ctx),
    ).rejects.toMatchObject({ code: "VOICE_OUT_OF_CREDIT" });
  });

  it("asks for OpenAI JSON transcripts and names iPhone recordings as m4a", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"text":" hello there "}'));
    const result = await provider(fetchMock).transcribe(
      { audio: new Uint8Array([1]), mimeType: "audio/mp4", language: "en-US", apiKey: keyless },
      ctx,
    );
    expect(result).toEqual({ text: "hello there" });
    expect(calledInit(fetchMock).redirect).toBe("error");
    expect(calledUrl(fetchMock)).toBe("http://100.64.0.10:8810/v1/audio/transcriptions");
    const form = calledInit(fetchMock).body as FormData;
    expect(form.get("model")).toBe(DEFAULT_COMPATIBLE_STT_MODEL);
    expect(form.get("response_format")).toBe("json");
    expect(form.get("language")).toBe("en");
    expect((form.get("file") as File).name).toBe("speech.m4a");
  });

  it("accepts a plain-text transcript body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("hello there\n"));
    await expect(
      provider(fetchMock).transcribe(
        { audio: new Uint8Array([1]), mimeType: "audio/webm", apiKey: keyless },
        ctx,
      ),
    ).resolves.toEqual({ text: "hello there" });
  });

  it.each(["1234", "true", "null", '"quoted"'])(
    "keeps a text/plain transcript that looks like JSON: %s",
    async (spoken) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response(spoken, { headers: { "content-type": "text/plain" } }));
      await expect(
        provider(fetchMock).transcribe(
          { audio: new Uint8Array([1]), mimeType: "audio/webm", apiKey: keyless },
          ctx,
        ),
      ).resolves.toEqual({ text: spoken });
    },
  );

  it("refuses a non-text, non-JSON transcription reply", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response("<html>login</html>", { headers: { "content-type": "text/html" } }),
      );
    await expect(
      provider(fetchMock).transcribe(
        { audio: new Uint8Array([1]), mimeType: "audio/webm", apiKey: keyless },
        ctx,
      ),
    ).rejects.toThrow("The speech server did not return a transcript.");
  });

  it("refuses a saved base URL that now points somewhere blocked", async () => {
    const fetchMock = vi.fn();
    const tampered = JSON.stringify({
      ...parseOpenAiCompatibleVoiceSecret(keyless),
      baseUrl: "http://169.254.169.254/v1",
    });
    await expect(
      provider(fetchMock).synthesize({ text: "Hi", voiceId: "af_heart", apiKey: tampered }, ctx),
    ).rejects.toThrow(/blocked/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

it.each(["text/html", "audio/wav", "", `text/${"x".repeat(500)}`])(
  "rejects speech content type %s without echoing server headers",
  async (type) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(new Uint8Array([1]), { headers: type ? { "content-type": type } : {} }),
      );
    await expect(
      provider(fetchMock).synthesize({ text: "Hi", voiceId: "alloy", apiKey: keyless }, ctx),
    ).rejects.toThrow("The speech server did not return MP3 audio.");
  },
);

it("does not echo a key reflected in a server error", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ detail: "Invalid local-test-key" }), { status: 400 }),
    );
  const error = await provider(fetchMock)
    .synthesize({ text: "Hi", voiceId: "alloy", apiKey: keyed }, ctx)
    .catch((error: Error) => error);
  expect((error as Error).message).toBe("speaking failed: Invalid [redacted]");
});

it("rejects HTML transcripts even when their bodies parse as JSON", async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response('{"text":"login"}', {
      headers: { "content-type": "text/html" },
    }),
  );
  await expect(
    provider(fetchMock).transcribe(
      { audio: new Uint8Array([1]), mimeType: "audio/webm", apiKey: keyless },
      ctx,
    ),
  ).rejects.toThrow("The speech server did not return a transcript.");
});

it("does not expose transport error details while verifying a keyed server", async () => {
  const fetchMock = vi.fn().mockRejectedValue(new Error(`local-test-key\n${"x".repeat(500)}`));
  await expect(provider(fetchMock).verify(keyed, ctx)).resolves.toEqual({
    ok: false,
    message: "Couldn't reach the speech server at http://192.168.1.20:8880.",
  });
});
