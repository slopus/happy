import type { VoiceVerifyResult } from "@rakazo/adapter-kit";
import { VoiceAccountError } from "@rakazo/adapter-kit";
import type { VoiceAccountErrorCode } from "@rakazo/contracts";
import { cancelResponseBody } from "@rakazo/core";
import { readBodyCapped } from "./web-ssrf.js";

/** A 2,000-character utterance should stay far below this, even at high MP3 bitrates. */
export const MAX_SYNTHESIZED_AUDIO_BYTES = 16 * 1024 * 1024;
export const MAX_SPEAK_CHARS = 2000;
export const MAX_VOICE_JSON_BYTES = 1024 * 1024;

/** Header-safe speech model id. A connection override wins over the deployment default. */
export function isSpeechModelId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
}

/** Client disconnect plus a hard deadline — `context.signal` is always set. */
export function voiceDeadline(signal: AbortSignal, ms: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}

export async function readVoiceAudio(res: Response, signal?: AbortSignal): Promise<Uint8Array> {
  return readVoiceBytes(res, MAX_SYNTHESIZED_AUDIO_BYTES, signal);
}

async function readVoiceBytes(
  res: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const declared = Number(res.headers?.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    cancelResponseBody(res);
    throw new Error("Voice response is too large.");
  }
  try {
    return await readBodyCapped(res, maxBytes, signal);
  } catch (error) {
    if (error instanceof Error && error.message === "Response is too large") {
      throw new Error("Voice response is too large.");
    }
    throw error;
  }
}

export function speechUploadName(mimeType?: string): string {
  const mime = (mimeType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime.includes("webm")) return "speech.webm";
  if (mime.includes("ogg") || mime.includes("opus")) return "speech.ogg";
  if (mime.includes("wav")) return "speech.wav";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "speech.mp3";
  if (mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac")) return "speech.m4a";
  return "speech.webm";
}

/** The reply as text, capped like JSON replies. Null when it cannot be read. */
export async function readVoiceText(res: Response): Promise<string | null> {
  try {
    return new TextDecoder().decode(await readVoiceBytes(res, MAX_VOICE_JSON_BYTES));
  } catch (error) {
    if (error instanceof Error && error.message === "Voice response is too large.") throw error;
    return null;
  }
}

export async function readVoiceJson(
  res: Response,
  options: { requireValid?: boolean; rawOnInvalid?: boolean } = {},
): Promise<unknown> {
  let bytes: Uint8Array;
  try {
    bytes = await readVoiceBytes(res, MAX_VOICE_JSON_BYTES);
  } catch (error) {
    if (error instanceof Error && error.message === "Voice response is too large.") throw error;
    if (options.requireValid) throw new Error("Voice provider response could not be read.");
    return null;
  }
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text);
  } catch {
    if (options.requireValid) throw new Error("Voice provider returned invalid JSON.");
    return options.rawOnInvalid ? text : null;
  }
}

export function voiceErrorDetail(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  if (typeof record.detail === "string" && record.detail.trim()) return record.detail.trim();
  // Validation errors (422) list each problem as `{ loc, msg, type }`.
  if (Array.isArray(record.detail)) {
    return record.detail
      .map((item) => (item && typeof item === "object" ? (item as { msg?: unknown }).msg : item))
      .filter((msg): msg is string => typeof msg === "string" && !!msg.trim())
      .map((msg) => msg.trim())
      .join("; ");
  }
  if (
    record.detail &&
    typeof record.detail === "object" &&
    typeof (record.detail as { message?: unknown }).message === "string"
  ) {
    return String((record.detail as { message: string }).message).trim();
  }
  if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
  if (typeof record.error === "string" && record.error.trim()) return record.error.trim();
  if (
    record.error &&
    typeof record.error === "object" &&
    typeof (record.error as { message?: unknown }).message === "string"
  ) {
    return String((record.error as { message: string }).message).trim();
  }
  return "";
}

/** ElevenLabs' machine-readable `detail.status`, such as `invalid_api_key` or `quota_exceeded`. */
function reasonCode(body: unknown): string | undefined {
  const value = (body as { detail?: { status?: unknown } } | null)?.detail;
  return value && typeof value === "object" && typeof value.status === "string"
    ? value.status
    : undefined;
}

export function voiceUnreachable(provider: string): string {
  return `Couldn't reach ${provider} to check that key. Check your connection.`;
}

export function voiceHttpError(
  status: number,
  provider: string,
  what: string,
  body: unknown,
): string {
  const theirs = voiceErrorDetail(body);
  if (status === 401 || status === 403) {
    // ElevenLabs also answers 401 for spent quota and missing key permissions.
    const reason = reasonCode(body);
    if (reason === "missing_permissions")
      return theirs || `That ${provider} key is missing a permission this needs.`;
    if (!reason || reason === "invalid_api_key" || !theirs)
      return `${provider} rejected that key. Check the key and that it has speech permissions.`;
    return theirs;
  }
  if (status === 429)
    return theirs || `${provider} is rate-limiting this account. Wait a moment and try again.`;
  if (status === 402) return theirs || `${provider} says this account is out of credit.`;
  return theirs ? `${what} failed: ${theirs}` : `${what} failed (${status})`;
}

/** OpenAI's machine-readable `error.code` or `error.type`, such as `insufficient_quota`. */
function openAiErrorCode(body: unknown): string | undefined {
  const error = (body as { error?: unknown } | null)?.error;
  if (!error || typeof error !== "object") return undefined;
  const { code, type } = error as { code?: unknown; type?: unknown };
  if (typeof code === "string") return code;
  return typeof type === "string" ? type : undefined;
}

/** OpenAI also answers 429 for billing with other codes; only the message tells them apart. */
const BILLING_MESSAGE =
  /\bcredits?\b|billing|exceeded your current quota|paid subscription|account is not active/i;

/**
 * A failure the user fixes in their provider account. 402 is spent credit (Fish Audio,
 * Cartesia), OpenAI sends 429 `insufficient_quota` or a billing message, ElevenLabs
 * sends 401 `quota_exceeded`. Other 401s and 403s are a rejected key.
 */
export function voiceAccountIssue(
  status: number,
  body: unknown,
): VoiceAccountErrorCode | undefined {
  if (status === 402) return "VOICE_OUT_OF_CREDIT";
  if (status === 429) {
    return openAiErrorCode(body) === "insufficient_quota" ||
      BILLING_MESSAGE.test(voiceErrorDetail(body))
      ? "VOICE_OUT_OF_CREDIT"
      : undefined;
  }
  if (status !== 401 && status !== 403) return undefined;
  const reason = reasonCode(body);
  if (reason === "quota_exceeded") return "VOICE_OUT_OF_CREDIT";
  return !reason || reason === "invalid_api_key" ? "VOICE_KEY_REJECTED" : undefined;
}

/** The error a failed provider request throws; any 401 or 403 is the user's account to fix. */
export function voiceRequestError(
  status: number,
  provider: string,
  what: string,
  body: unknown,
  /** The provider's original body, when `body` was trimmed for display. */
  rawBody: unknown = body,
): Error {
  const message = voiceHttpError(status, provider, what, body);
  const code = voiceAccountIssue(status, rawBody);
  return code || status === 401 || status === 403
    ? new VoiceAccountError(code, message)
    : new Error(message);
}

export async function requireOk(res: Response, provider: string, what: string): Promise<Response> {
  if (res.ok) return res;
  throw voiceRequestError(res.status, provider, what, await readVoiceJson(res));
}

export async function verifyVoiceHttpGet(options: {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  provider: string;
}): Promise<VoiceVerifyResult> {
  try {
    const res = await fetch(options.url, {
      headers: options.headers,
      signal: voiceDeadline(options.signal, 20_000),
    });
    if (res.ok) {
      cancelResponseBody(res);
      return { ok: true };
    }
    const body = await readVoiceJson(res);
    return {
      ok: false,
      message: voiceHttpError(res.status, options.provider, "checking that key", body),
      code: voiceAccountIssue(res.status, body),
    };
  } catch {
    return {
      ok: false,
      message: voiceUnreachable(options.provider),
    };
  }
}

const LANGUAGE_TAG = /^([A-Za-z]{2,3})(?:-[A-Za-z0-9]{2,8})*$/;

/**
 * The lowercase primary language subtag speech-to-text providers expect, or undefined when the
 * value is not a tag we can honor ("es-ES" and "es" both ask for Spanish).
 */
export function voiceLanguageHint(language: string | undefined): string | undefined {
  const match = LANGUAGE_TAG.exec(language?.trim() ?? "");
  return match?.[1] ? match[1].toLowerCase() : undefined;
}
