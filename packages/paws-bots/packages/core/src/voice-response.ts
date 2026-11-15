import { readJsonObjectWithin, readResponseWithin } from "./response-bytes.js";

/** How long a client waits for `/api/voice/*` to answer. */
export const VOICE_RESPONSE_TIMEOUT_MS = 70_000;
/** The most a transcription response may be; a transcript is far smaller. */
export const MAX_TRANSCRIPTION_RESPONSE_BYTES = 64 * 1024;
/** Matches the server's cap on synthesized audio. */
export const MAX_VOICE_AUDIO_BYTES = 16 * 1024 * 1024;
const MAX_VOICE_ERROR_BYTES = 64 * 1024;
const VOICE_TOO_LARGE = "Voice response is too large.";

export type VoiceErrorBody = { error?: string; code?: string };

export function readVoiceAudio(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  return readResponseWithin(response, {
    maxBytes: MAX_VOICE_AUDIO_BYTES,
    tooLargeMessage: VOICE_TOO_LARGE,
    signal,
  });
}

/** The `{ error, code }` body of a failed voice response; any other body reads as `{}`. */
export function readVoiceError(response: Response, signal: AbortSignal): Promise<VoiceErrorBody> {
  return readJsonObjectWithin<VoiceErrorBody>(response, {
    maxBytes: MAX_VOICE_ERROR_BYTES,
    tooLargeMessage: VOICE_TOO_LARGE,
    signal,
  });
}
