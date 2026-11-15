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

async function synthesizeRequest(model: string | undefined) {
  const fetch = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(new Uint8Array([7, 8]), { headers: { "content-type": "audio/mpeg" } }),
  );
  vi.stubGlobal("fetch", fetch);
  const clip = await new ElevenLabsVoiceProvider().synthesize(
    { text: "Cześć.", voiceId: "voice/1", apiKey: "test-key", model },
    context,
  );
  expect(clip).toEqual({ bytes: new Uint8Array([7, 8]), mimeType: "audio/mpeg" });
  const [url, init] = fetch.mock.calls[0] ?? [];
  return { url: String(url), body: JSON.parse(String(init?.body)) };
}

describe("ElevenLabs speech", () => {
  it.each([
    [undefined, "eleven_flash_v2_5"],
    [" ", "eleven_flash_v2_5"],
    ["eleven_v4", "eleven_v4"],
  ])("speaks with the connection model %j as %s", async (model, modelId) => {
    const { url, body } = await synthesizeRequest(model);
    expect(url).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/voice%2F1?output_format=mp3_44100_64",
    );
    expect(body).toEqual({ text: "Cześć.", model_id: modelId });
  });
});
