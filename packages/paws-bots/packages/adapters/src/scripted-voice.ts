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

export const SCRIPTED_VOICE_ID = "alloy-test";
export const SCRIPTED_TRANSCRIPT = "hello from the test microphone";

/** A tiny MPEG frame so `/api/voice/speak` can return `audio/mpeg` without a live vendor. */
export const SCRIPTED_MPEG = Uint8Array.from([
  0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

export const SCRIPTED_VOICE_CATALOG_ENTRY = {
  id: "scripted",
  name: "Scripted",
  description: "Deterministic fixture for tests. No billed speech.",
  transcribe: true,
} as const;

export class ScriptedVoiceProvider implements VoiceProvider {
  describe(): AdapterDescriptor<VoiceCapabilities> {
    return {
      id: "scripted",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { catalog: true, synthesize: true, transcribe: true },
    };
  }

  async verify(apiKey: string, _context: AdapterContext): Promise<VoiceVerifyResult> {
    if (apiKey.trim().length < 8) {
      return { ok: false, message: "That key is too short." };
    }
    return { ok: true };
  }

  async listVoices(_apiKey: string, _context: AdapterContext): Promise<VoiceInfo[]> {
    return [{ id: SCRIPTED_VOICE_ID, label: "Scripted", description: "Test voice" }];
  }

  async synthesize(
    _request: VoiceSynthesizeRequest,
    _context: AdapterContext,
  ): Promise<SpeechClip> {
    return { bytes: new Uint8Array(SCRIPTED_MPEG), mimeType: "audio/mpeg" };
  }

  async transcribe(
    _request: VoiceTranscribeRequest,
    _context: AdapterContext,
  ): Promise<{ text: string }> {
    return { text: SCRIPTED_TRANSCRIPT };
  }
}
