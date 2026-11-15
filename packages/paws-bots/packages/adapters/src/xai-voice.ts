import type {
  AdapterContext,
  AdapterDescriptor,
  SpeechClip,
  VoiceCapabilities,
  VoiceInfo,
  VoiceProvider,
  VoiceSynthesizeRequest,
  VoiceTranscribeRequest,
  VoiceVerifyResult,
} from "@rakazo/adapter-kit";
import { VoiceAccountError } from "@rakazo/adapter-kit";
import {
  readVoiceAudio,
  readVoiceJson,
  speechUploadName,
  voiceDeadline,
  voiceErrorDetail,
  voiceLanguageHint,
  voiceRequestError,
  voiceUnreachable,
} from "./voice-http.js";

export const XAI_VOICE_PROVIDER_ID = "xai";
const API = "https://api.x.ai/v1";
const PROVIDER = "xAI";

/**
 * Speech and transcription through xAI. The bearer is either an xAI API key or the access token
 * of a SuperGrok or X Premium sign-in; both reach the same endpoints.
 */
export class XaiVoiceProvider implements VoiceProvider {
  describe(): AdapterDescriptor<VoiceCapabilities> {
    return {
      id: XAI_VOICE_PROVIDER_ID,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { catalog: true, synthesize: true, transcribe: true },
    };
  }

  async verify(apiKey: string, context: AdapterContext): Promise<VoiceVerifyResult> {
    try {
      const res = await fetch(`${API}/tts/voices`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: voiceDeadline(context.signal, 20_000),
      });
      if (res.ok) return { ok: true };
      const error = xaiRequestError(res.status, "checking that key", await readVoiceJson(res));
      return {
        ok: false,
        message: error.message,
        code: error instanceof VoiceAccountError ? error.code : undefined,
      };
    } catch {
      return { ok: false, message: voiceUnreachable(PROVIDER) };
    }
  }

  async listVoices(apiKey: string, context: AdapterContext): Promise<VoiceInfo[]> {
    const res = await fetch(`${API}/tts/voices`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: voiceDeadline(context.signal, 20_000),
    });
    if (!res.ok) throw xaiRequestError(res.status, "listing voices", await readVoiceJson(res));
    const body = await readVoiceJson(res, { requireValid: true });
    const listed =
      body && typeof body === "object" && "voices" in body && Array.isArray(body.voices)
        ? body.voices
        : [];
    const voices: VoiceInfo[] = [];
    for (const voice of listed) {
      if (!voice || typeof voice !== "object" || !("voice_id" in voice)) continue;
      const id = voice.voice_id;
      if (typeof id !== "string" || !id.trim()) continue;
      const name = "name" in voice && typeof voice.name === "string" ? voice.name.trim() : "";
      voices.push({ id, label: name || id });
    }
    return voices.sort((a, b) => a.label.localeCompare(b.label));
  }

  async synthesize(request: VoiceSynthesizeRequest, context: AdapterContext): Promise<SpeechClip> {
    const signal = voiceDeadline(request.signal ?? context.signal, 60_000);
    const res = await fetch(`${API}/tts`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${request.apiKey}`,
        "content-type": "application/json",
      },
      // MP3 at 24 kHz is the default output; replies can be in any language.
      body: JSON.stringify({ text: request.text, voice_id: request.voiceId, language: "auto" }),
      signal,
    });
    if (!res.ok) throw xaiRequestError(res.status, "speaking", await readVoiceJson(res));
    return { bytes: await readVoiceAudio(res, signal), mimeType: "audio/mpeg" };
  }

  async transcribe(
    request: VoiceTranscribeRequest,
    context: AdapterContext,
  ): Promise<{ text: string }> {
    const form = new FormData();
    const language = voiceLanguageHint(request.language);
    if (language) {
      form.set("language", language);
      // Writes spoken numbers, prices and units as a person would type them.
      form.set("format", "true");
    }
    // xAI reads fields only up to the file, so it goes last.
    form.set(
      "file",
      new Blob([new Uint8Array(request.audio)], { type: request.mimeType || "audio/webm" }),
      speechUploadName(request.mimeType),
    );
    const res = await fetch(`${API}/stt`, {
      method: "POST",
      headers: { authorization: `Bearer ${request.apiKey}` },
      body: form,
      signal: voiceDeadline(request.signal ?? context.signal, 60_000),
    });
    const body = await readVoiceJson(res, { requireValid: res.ok });
    if (!res.ok) throw xaiRequestError(res.status, "transcribing", body);
    const text = body && typeof body === "object" && "text" in body ? body.text : undefined;
    return { text: typeof text === "string" ? text.trim() : "" };
  }
}

/** Normalize xAI's account statuses only at its adapter boundary. */
function xaiRequestError(status: number, what: string, body: unknown): Error {
  const message = voiceErrorDetail(body);
  if (status === 400 && /\b(?:incorrect|invalid) api key\b/i.test(message)) status = 401;
  if (
    status === 403 &&
    /\bcredits?\b|billing|paid subscription|account is not active/i.test(message)
  )
    status = 402;
  return voiceRequestError(status, PROVIDER, what, body);
}
