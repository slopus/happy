import { afterEach, expect, it, vi } from "vitest";
import { OpenAIVoiceProvider } from "./openai-voice.js";

const context = {
  operationId: "voice",
  traceId: "voice",
  spaceId: "test",
  userId: "test",
  signal: new AbortController().signal,
};

afterEach(() => vi.unstubAllGlobals());

it.each(["marin"])("lists and sends the %s voice for speech", async (voiceId) => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1]), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const provider = new OpenAIVoiceProvider();

  expect((await provider.listVoices("test-key", context)).map((voice) => voice.id)).toContain(
    voiceId,
  );
  await provider.synthesize({ apiKey: "test-key", voiceId, text: "Hello" }, context);
  expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body)).toMatchObject({
    model: "gpt-4o-mini-tts",
    voice: voiceId,
  });
});

it.each([
  ["es", "es"],
  ["pt-BR", "pt"],
  ["zh-Hant-TW", "zh"],
  [" EN-us ", "en"],
  [undefined, null],
  ["", null],
  ["not a language", null],
  ["eng", null],
])("transcribes with normalized language %s", async (language, expected) => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ text: "  Hola  " }));
  vi.stubGlobal("fetch", fetchMock);
  const audio = new Uint8Array([1, 2, 3]);
  const result = await new OpenAIVoiceProvider().transcribe(
    { apiKey: "test-key", audio, mimeType: "audio/webm", language },
    context,
  );

  expect(result).toEqual({ text: "Hola" });
  expect(fetchMock).toHaveBeenCalledOnce();
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
  expect(init.method).toBe("POST");
  expect(init.headers).toEqual({ authorization: "Bearer test-key" });
  const form = init.body as FormData;
  expect(form.get("model")).toBe("gpt-4o-mini-transcribe");
  expect(form.get("language")).toBe(expected);
  const file = form.get("file") as File;
  expect(file.name).toBe("speech.webm");
  expect(file.type).toBe("audio/webm");
  expect(new Uint8Array(await file.arrayBuffer())).toEqual(audio);
});
