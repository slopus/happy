import type {
  AdapterContext,
  AdapterDescriptor,
  SpeechClip,
  VoiceCapabilities,
  VoiceInfo,
  VoiceProvider,
  VoiceSynthesizeRequest,
  VoiceVerifyResult,
} from "@rakazo/adapter-kit";
import {
  readVoiceAudio,
  readVoiceJson,
  requireOk,
  verifyVoiceHttpGet,
  voiceDeadline,
  voiceRequestError,
} from "./voice-http.js";

const API = "https://api.cartesia.ai";
// From 2026-03-01 errors are JSON with a `message`; `/voices` pages with `limit`.
const VERSION = "2026-08-14";
const MODEL = "sonic-3";
const VOICE_PAGE_LIMIT = 100;
const VERIFY_PAGE_LIMIT = 1;
/** Bounds the catalog walk so a very large library cannot spin forever. */
const VOICE_MAX_PAGES = 20;

export class CartesiaVoiceProvider implements VoiceProvider {
  describe(): AdapterDescriptor<VoiceCapabilities> {
    return {
      id: "cartesia",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { catalog: true, synthesize: true, transcribe: false },
    };
  }

  async verify(apiKey: string, context: AdapterContext): Promise<VoiceVerifyResult> {
    return verifyVoiceHttpGet({
      url: `${API}/voices?limit=${VERIFY_PAGE_LIMIT}`,
      headers: cartesiaHeaders(apiKey),
      signal: context.signal,
      provider: "Cartesia",
    });
  }

  async listVoices(apiKey: string, context: AdapterContext): Promise<VoiceInfo[]> {
    const signal = voiceDeadline(context.signal, 20_000);
    const voices: Array<Record<string, unknown>> = [];
    let startingAfter: string | undefined;
    // `limit` is per page, so walk the cursor to keep voices past the first page in the picker
    // while each response stays inside the voice JSON read cap.
    for (let page = 0; page < VOICE_MAX_PAGES; page++) {
      const params = new URLSearchParams({ limit: String(VOICE_PAGE_LIMIT) });
      if (startingAfter) params.set("starting_after", startingAfter);
      const res = await fetch(`${API}/voices?${params}`, {
        headers: cartesiaHeaders(apiKey),
        signal,
      });
      const body = await readVoiceJson(res, { requireValid: res.ok });
      if (!res.ok) throw voiceRequestError(res.status, "Cartesia", "listing voices", body);
      const items = voicesFrom(body);
      voices.push(...items);
      const next = nextVoicePage(body, items);
      if (!next) break;
      startingAfter = next;
    }
    return voices
      .map((voice) => ({
        id: String(voice.id ?? voice.voice_id ?? ""),
        label: String(voice.name ?? "Voice"),
        description: typeof voice.description === "string" ? voice.description : undefined,
      }))
      .filter((voice) => voice.id);
  }

  async synthesize(request: VoiceSynthesizeRequest, context: AdapterContext): Promise<SpeechClip> {
    const signal = voiceDeadline(request.signal ?? context.signal, 60_000);
    const res = await fetch(`${API}/tts/bytes`, {
      method: "POST",
      headers: {
        ...cartesiaHeaders(request.apiKey),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model_id: MODEL,
        transcript: request.text,
        voice: { id: request.voiceId },
        // Cartesia's mp3 container takes bit_rate, not encoding: an encoding key rejects the request.
        output_format: { container: "mp3", sample_rate: 44100, bit_rate: 128000 },
      }),
      signal,
    });
    await requireOk(res, "Cartesia", "speaking");
    return { bytes: await readVoiceAudio(res, signal), mimeType: "audio/mpeg" };
  }
}

function cartesiaHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Cartesia-Version": VERSION };
}

/** The cursor for the next catalog page, or undefined when this was the last one. */
function nextVoicePage(
  body: unknown,
  items: ReadonlyArray<Record<string, unknown>>,
): string | undefined {
  if (items.length === 0 || !body || typeof body !== "object") return undefined;
  const meta = body as { has_more?: unknown; next_page?: unknown };
  if (meta.has_more !== true) return undefined;
  if (typeof meta.next_page === "string" && meta.next_page) return meta.next_page;
  // Older payloads omit next_page and expect the last id as the cursor.
  const last = items[items.length - 1];
  const id = String(last?.id ?? last?.voice_id ?? "");
  return id || undefined;
}

function voicesFrom(body: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(body)) return body as Array<Record<string, unknown>>;
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (Array.isArray(record.data)) return record.data as Array<Record<string, unknown>>;
    if (Array.isArray(record.voices)) return record.voices as Array<Record<string, unknown>>;
  }
  return [];
}
