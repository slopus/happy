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
import {
  readVoiceAudio,
  readVoiceJson,
  requireOk,
  speechUploadName,
  verifyVoiceHttpGet,
  voiceDeadline,
  voiceLanguageHint,
  voiceRequestError,
} from "./voice-http.js";

const API = "https://api.openai.com/v1";
const TTS_MODEL = "gpt-4o-mini-tts";
const STT_MODEL = "gpt-4o-mini-transcribe";

export const OPENAI_VOICES: VoiceInfo[] = [
  { id: "alloy", label: "Alloy", description: "Neutral" },
  { id: "ash", label: "Ash", description: "Clear" },
  { id: "ballad", label: "Ballad", description: "Warm" },
  { id: "cedar", label: "Cedar" },
  { id: "coral", label: "Coral", description: "Bright" },
  { id: "echo", label: "Echo", description: "Even" },
  { id: "fable", label: "Fable", description: "Narrative" },
  { id: "marin", label: "Marin" },
  { id: "onyx", label: "Onyx", description: "Deep" },
  { id: "nova", label: "Nova", description: "Energetic" },
  { id: "sage", label: "Sage", description: "Calm" },
  { id: "shimmer", label: "Shimmer", description: "Soft" },
  { id: "verse", label: "Verse", description: "Expressive" },
];

export class OpenAIVoiceProvider implements VoiceProvider {
  describe(): AdapterDescriptor<VoiceCapabilities> {
    return {
      id: "openai",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { catalog: true, synthesize: true, transcribe: true },
    };
  }

  async verify(apiKey: string, context: AdapterContext): Promise<VoiceVerifyResult> {
    return verifyVoiceHttpGet({
      url: `${API}/models`,
      headers: { authorization: `Bearer ${apiKey}` },
      signal: context.signal,
      provider: "OpenAI",
    });
  }

  async listVoices(_apiKey: string, _context: AdapterContext): Promise<VoiceInfo[]> {
    return OPENAI_VOICES;
  }

  async synthesize(request: VoiceSynthesizeRequest, context: AdapterContext): Promise<SpeechClip> {
    const signal = voiceDeadline(request.signal ?? context.signal, 60_000);
    const res = await fetch(`${API}/audio/speech`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${request.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: TTS_MODEL,
        voice: request.voiceId,
        input: request.text,
        response_format: "mp3",
      }),
      signal,
    });
    await requireOk(res, "OpenAI", "speaking");
    return { bytes: await readVoiceAudio(res, signal), mimeType: "audio/mpeg" };
  }

  async transcribe(
    request: VoiceTranscribeRequest,
    context: AdapterContext,
  ): Promise<{ text: string }> {
    const form = new FormData();
    form.set("model", STT_MODEL);
    const language = voiceLanguageHint(request.language);
    if (language?.length === 2) form.set("language", language);
    form.set(
      "file",
      new Blob([new Uint8Array(request.audio)], { type: request.mimeType || "audio/webm" }),
      speechUploadName(request.mimeType),
    );
    const res = await fetch(`${API}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${request.apiKey}` },
      body: form,
      signal: voiceDeadline(request.signal ?? context.signal, 60_000),
    });
    const body = await readVoiceJson(res, { requireValid: res.ok });
    if (!res.ok) throw voiceRequestError(res.status, "OpenAI", "transcribing", body);
    return { text: String((body as { text?: unknown } | null)?.text ?? "").trim() };
  }
}
