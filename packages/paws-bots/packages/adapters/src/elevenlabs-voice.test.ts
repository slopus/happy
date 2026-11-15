import type { AdapterContext } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ElevenLabsVoiceProvider } from "./elevenlabs-voice.js";

const context: AdapterContext = {
  operationId: "test-operation",
  traceId: "test-trace",
  spaceId: "test-space",
  userId: "test-user",
  signal: new AbortController().signal,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

async function transcribeForm(language: string | undefined): Promise<FormData> {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({ text: " Mówimy o Javie. " }),
  );
  vi.stubGlobal("fetch", fetch);
  const result = await new ElevenLabsVoiceProvider().transcribe(
    { audio: new Uint8Array([1, 2, 3]), mimeType: "audio/webm", apiKey: "test-key", language },
    context,
  );
  expect(result).toEqual({ text: "Mówimy o Javie." });
  expect(String(fetch.mock.calls[0]?.[0])).toBe("https://api.elevenlabs.io/v1/speech-to-text");
  return fetch.mock.calls[0]?.[1]?.body as FormData;
}

describe("ElevenLabs transcription", () => {
  it.each([
    ["pl", "pl"],
    ["pl-PL", "pl"],
    ["PT-br", "pt"],
  ])("sends the language hint %s as language_code %s", async (language, code) => {
    const form = await transcribeForm(language);
    expect(form.get("model_id")).toBe("scribe_v2");
    expect(form.get("language_code")).toBe(code);
  });

  it.each([undefined, "", "not a tag"])(
    "leaves detection to the provider for %j",
    async (language) => {
      const form = await transcribeForm(language);
      expect(form.has("language_code")).toBe(false);
    },
  );
});
