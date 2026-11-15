import type { AdapterContext } from "@rakazo/adapter-kit";
import { VoiceAccountError } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { XaiVoiceProvider } from "./xai-voice.js";

const context: AdapterContext = {
  operationId: "test-operation",
  traceId: "test-trace",
  spaceId: "test-space",
  userId: "test-user",
  signal: new AbortController().signal,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(response: () => Response) {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response());
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("XaiVoiceProvider", () => {
  it("speaks through the TTS endpoint and returns MP3 bytes", async () => {
    const fetch = stubFetch(
      () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } }),
    );

    const clip = await new XaiVoiceProvider().synthesize(
      { text: "Olá", voiceId: "eve", apiKey: "xai-key" },
      context,
    );

    expect(clip).toEqual({ bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/mpeg" });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://api.x.ai/v1/tts");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer xai-key");
    expect(JSON.parse(String(init?.body))).toEqual({
      text: "Olá",
      voice_id: "eve",
      language: "auto",
    });
  });

  it("lists voices by name and skips entries without an id", async () => {
    const fetch = stubFetch(() =>
      Response.json({
        voices: [
          { voice_id: "rex", name: "Rex" },
          { name: "Nameless" },
          { voice_id: "ara", name: "Ara" },
          { voice_id: "sal" },
        ],
      }),
    );

    await expect(new XaiVoiceProvider().listVoices("xai-key", context)).resolves.toEqual([
      { id: "ara", label: "Ara" },
      { id: "rex", label: "Rex" },
      { id: "sal", label: "sal" },
    ]);
    expect(String(fetch.mock.calls[0]![0])).toBe("https://api.x.ai/v1/tts/voices");
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get("authorization")).toBe(
      "Bearer xai-key",
    );
  });

  it("reports xAI's incorrect-key reply as a rejected key", async () => {
    const fetch = stubFetch(() =>
      Response.json(
        {
          code: "Client specified an invalid argument",
          error:
            "Incorrect API key provided: xa***. You can obtain an API key from https://console.x.ai.",
        },
        { status: 400 },
      ),
    );

    const result = await new XaiVoiceProvider().verify("xai-wrong", context);

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      message: "xAI rejected that key. Check the key and that it has speech permissions.",
    });
    expect(String(fetch.mock.calls[0]![0])).toBe("https://api.x.ai/v1/tts/voices");
  });

  it("uploads the recording last with a language hint and formatting", async () => {
    const fetch = stubFetch(() => Response.json({ text: "  olá mundo " }));

    const result = await new XaiVoiceProvider().transcribe(
      { audio: new Uint8Array([1]), mimeType: "audio/ogg", apiKey: "xai-key", language: "pt-BR" },
      context,
    );

    expect(result).toEqual({ text: "olá mundo" });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://api.x.ai/v1/stt");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer xai-key");
    const form = init?.body as FormData;
    expect([...form.keys()]).toEqual(["language", "format", "file"]);
    expect(form.get("language")).toBe("pt");
    expect(form.get("format")).toBe("true");
    expect((form.get("file") as File).name).toBe("speech.ogg");
  });

  it("omits the language and formatting for an invalid hint", async () => {
    const fetch = stubFetch(() => Response.json({ text: "hi" }));

    await new XaiVoiceProvider().transcribe(
      { audio: new Uint8Array([1]), mimeType: "audio/webm", apiKey: "xai-key", language: "??" },
      context,
    );

    const form = fetch.mock.calls[0]![1]?.body as FormData;
    expect([...form.keys()]).toEqual(["file"]);
  });

  it("raises xAI's own words when the account has no credit", async () => {
    const message = "You have run out of credits or need a Grok subscription";
    stubFetch(() => Response.json({ error: message }, { status: 403 }));

    const error = await new XaiVoiceProvider()
      .transcribe(
        { audio: new Uint8Array([1]), mimeType: "audio/webm", apiKey: "xai-key" },
        context,
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(VoiceAccountError);
    expect(error).toMatchObject({ code: "VOICE_OUT_OF_CREDIT", message });
  });
});
