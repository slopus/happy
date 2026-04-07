/**
 * OpenAI voice configuration.
 * Constants for the STT (Realtime transcription API) and TTS (REST speech API).
 */

export const OPENAI_VOICE = 'fable';
export const OPENAI_AUDIO_FORMAT = 'pcm16';
export const OPENAI_SAMPLE_RATE = 24000;
export const OPENAI_TRANSCRIPTION_MODEL = 'whisper-1';
export const OPENAI_TTS_MODEL = 'gpt-4o-mini-tts';
export const OPENAI_TTS_SPEED = 1.3;
export const OPENAI_TTS_INSTRUCTIONS = `Speak in a clear, neutral tone. Pronounce forward slashes in file paths as "slash". Say code identifiers naturally (e.g. "get user by ID" not "getUserById").`;
