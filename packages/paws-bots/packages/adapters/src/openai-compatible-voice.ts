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
  DEFAULT_COMPATIBLE_STT_MODEL,
  DEFAULT_COMPATIBLE_TTS_MODEL,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from "@rakazo/contracts";
import {
  assertAllowedOpenAiCompatibleUrl,
  assertHttpsForKeyedOpenAiCompatibleUrl,
  normalizeOpenAiCompatibleBaseUrl,
} from "./openai-compatible-url.js";
import { OPENAI_VOICES } from "./openai-voice.js";
import { createOpenAiCompatibleFetch } from "./pi-openai-compatible-provider.js";
import {
  readVoiceAudio,
  readVoiceJson,
  readVoiceText,
  speechUploadName,
  voiceDeadline,
  voiceHttpError,
  voiceLanguageHint,
  voiceRequestError,
} from "./voice-http.js";

export { DEFAULT_COMPATIBLE_STT_MODEL, DEFAULT_COMPATIBLE_TTS_MODEL };
export const OPENAI_COMPATIBLE_VOICE_PROVIDER_ID = OPENAI_COMPATIBLE_PROVIDER_ID;

const PROVIDER_NAME = "The speech server";
const MAX_MODEL_ID_LENGTH = 200;
const VERIFY_DEADLINE_MS = 20_000;
const LIST_VOICES_DEADLINE_MS = 15_000;
const SPEAK_DEADLINE_MS = 60_000;
const TRANSCRIBE_DEADLINE_MS = 60_000;
const MODEL_ID_PATTERN = /^[\w.:/@+-]+$/;
/** Visible ASCII only, so a key can never break the Authorization header. */
const API_KEY_PATTERN = /^[\x21-\x7e]+$/;
const MAX_SERVER_DETAIL_LENGTH = 160;
/** A voice list is shown to the user, so it stays small: ids, short names, a few hundred. */
const MAX_LISTED_VOICES = 500;
const MAX_VOICE_LABEL_LENGTH = 120;

/** What the encrypted voice secret holds for a self-hosted speech server. */
export interface OpenAiCompatibleVoiceSecret {
  kind: "openai_compatible";
  baseUrl: string;
  apiKey?: string;
  ttsModel: string;
  sttModel: string;
}

function modelIdOrDefault(value: string | undefined, fallback: string, label: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return fallback;
  if (trimmed.length > MAX_MODEL_ID_LENGTH || !MODEL_ID_PATTERN.test(trimmed)) {
    throw new Error(`${label} model id is not valid.`);
  }
  return trimmed;
}

/**
 * Validate the connection form and return the secret plaintext to store. The base URL
 * gets /v1 like model connections do; public hosts stay behind the same gate. Blank
 * fields keep the previous key and models, but only for the same server, so a key is
 * never carried to a new address.
 */
export function serializeOpenAiCompatibleVoiceSecret(
  input: {
    baseUrl: string;
    apiKey?: string;
    ttsModel?: string;
    sttModel?: string;
  },
  previousPlaintext?: string,
  policy?: { allowPrivate?: boolean },
): string {
  const url = assertAllowedOpenAiCompatibleUrl(input.baseUrl, policy);
  const baseUrl = normalizeOpenAiCompatibleBaseUrl(input.baseUrl);
  const previous = previousPlaintext ? tryParseSecret(previousPlaintext) : undefined;
  const same = previous?.baseUrl === baseUrl ? previous : undefined;
  const apiKey = input.apiKey?.trim() || same?.apiKey;
  if (apiKey && !API_KEY_PATTERN.test(apiKey)) {
    throw new Error("That API key has characters a key cannot contain.");
  }
  assertHttpsForKeyedOpenAiCompatibleUrl(url, apiKey);
  const secret: OpenAiCompatibleVoiceSecret = {
    kind: "openai_compatible",
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
    ttsModel: modelIdOrDefault(
      input.ttsModel || same?.ttsModel,
      DEFAULT_COMPATIBLE_TTS_MODEL,
      "Speech",
    ),
    sttModel: modelIdOrDefault(
      input.sttModel || same?.sttModel,
      DEFAULT_COMPATIBLE_STT_MODEL,
      "Transcription",
    ),
  };
  return JSON.stringify(secret);
}

function tryParseSecret(plaintext: string): OpenAiCompatibleVoiceSecret | undefined {
  try {
    return parseOpenAiCompatibleVoiceSecret(plaintext);
  } catch {
    return undefined;
  }
}

export function parseOpenAiCompatibleVoiceSecret(plaintext: string): OpenAiCompatibleVoiceSecret {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new Error("Saved speech server settings are unreadable. Connect the server again.");
  }
  const record = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  if (record.kind !== "openai_compatible" || typeof record.baseUrl !== "string") {
    throw new Error("Saved speech server settings are unreadable. Connect the server again.");
  }
  return {
    kind: "openai_compatible",
    baseUrl: record.baseUrl,
    ...(typeof record.apiKey === "string" && record.apiKey ? { apiKey: record.apiKey } : {}),
    ttsModel: typeof record.ttsModel === "string" ? record.ttsModel : DEFAULT_COMPATIBLE_TTS_MODEL,
    sttModel: typeof record.sttModel === "string" ? record.sttModel : DEFAULT_COMPATIBLE_STT_MODEL,
  };
}

/** The non-secret part of a saved connection, for settings and disclosures. */
export interface OpenAiCompatibleVoiceServer {
  endpoint: string;
  ttsModel: string;
  sttModel: string;
}

/** Undefined when the saved secret is unreadable. Never includes the key. */
export function openAiCompatibleVoiceServer(
  plaintext: string,
): OpenAiCompatibleVoiceServer | undefined {
  const secret = tryParseSecret(plaintext);
  if (!secret) return undefined;
  try {
    return {
      endpoint: normalizeOpenAiCompatibleBaseUrl(secret.baseUrl),
      ttsModel: secret.ttsModel,
      sttModel: secret.sttModel,
    };
  } catch {
    return undefined;
  }
}

/**
 * Any private address is allowed, so echo only a short, single-line error from the
 * server: enough for "model not found", too little to read another service through it.
 */
function serverError(status: number, what: string, body: unknown, apiKey?: string): Error {
  const detail =
    body && typeof body === "object"
      ? (body as { detail?: unknown; error?: unknown; message?: unknown })
      : {};
  const nestedError =
    detail.error && typeof detail.error === "object"
      ? (detail.error as { message?: unknown }).message
      : undefined;
  const raw = [detail.detail, detail.message, detail.error, nestedError].find(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  const redacted = apiKey ? raw?.replaceAll(apiKey, "[redacted]") : raw;
  const short = redacted
    ?.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .trim()
    .slice(0, MAX_SERVER_DETAIL_LENGTH);
  return voiceRequestError(status, PROVIDER_NAME, what, short ? { detail: short } : null, body);
}

const KOKORO_ID = /^([abefhijpz])([fm])_([a-z]+)$/;
const KOKORO_LANGUAGES: Record<string, string> = {
  a: "American English",
  b: "British English",
  e: "Spanish",
  f: "French",
  h: "Hindi",
  i: "Italian",
  j: "Japanese",
  p: "Brazilian Portuguese",
  z: "Mandarin Chinese",
};

/** Kokoro's language code is the voice id's first letter (af_heart → "a"). */
export function kokoroLangCode(voiceId: string): string | undefined {
  return KOKORO_ID.exec(voiceId)?.[1];
}

function voiceInfo(id: string, name?: string): VoiceInfo {
  const kokoro = KOKORO_ID.exec(id);
  if (!kokoro) {
    const label = name
      ?.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
      .trim()
      .slice(0, MAX_VOICE_LABEL_LENGTH);
    return { id, label: label || id };
  }
  const [, lang, gender, base] = kokoro as unknown as [string, string, string, string];
  return {
    id,
    label: base.charAt(0).toUpperCase() + base.slice(1),
    description: `${KOKORO_LANGUAGES[lang]}, ${gender === "f" ? "female" : "male"}`,
  };
}

/** Shown when a Kokoro server has no voice list. af_heart first: it becomes the default. */
const KOKORO_FALLBACK_VOICES = [
  "af_heart",
  "af_bella",
  "af_nicole",
  "am_michael",
  "am_fenrir",
  "bf_emma",
  "bm_george",
  "bm_fable",
].map((id) => voiceInfo(id));

/** Other speech models, including hosted gateways, take the standard OpenAI voice names. */
function fallbackVoices(ttsModel: string): VoiceInfo[] {
  return /kokoro/i.test(ttsModel) ? KOKORO_FALLBACK_VOICES : OPENAI_VOICES;
}

/**
 * OpenAI has no voice list endpoint. Self-hosted servers answer GET /audio/voices in
 * one of these shapes: `{ data: [{ id, name }] }` (mlx-audio), `{ voices: [{ id, name }] }`
 * or `{ voices: ["af_heart"] }` (Kokoro-FastAPI), or a bare array of either.
 */
export function parseCompatibleVoiceList(body: unknown): VoiceInfo[] {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const entries = Array.isArray(body)
    ? body
    : Array.isArray(record.data)
      ? record.data
      : Array.isArray(record.voices)
        ? record.voices
        : [];
  const voices: VoiceInfo[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const id =
      typeof entry === "string"
        ? entry
        : entry && typeof entry === "object"
          ? (entry as { id?: unknown }).id
          : undefined;
    if (voices.length >= MAX_LISTED_VOICES) break;
    if (typeof id !== "string" || !id.trim() || id.length > 120 || seen.has(id)) continue;
    seen.add(id);
    const name =
      entry && typeof entry === "object" ? (entry as { name?: unknown }).name : undefined;
    voices.push(voiceInfo(id, typeof name === "string" ? name : undefined));
  }
  const preferred = voices.findIndex((voice) => voice.id === "af_heart");
  if (preferred > 0) voices.unshift(...voices.splice(preferred, 1));
  return voices;
}

function headers(secret: OpenAiCompatibleVoiceSecret, extra?: Record<string, string>) {
  return {
    ...(secret.apiKey ? { authorization: `Bearer ${secret.apiKey}` } : {}),
    ...extra,
  };
}

function endpoint(secret: OpenAiCompatibleVoiceSecret, path: string): string {
  return `${normalizeOpenAiCompatibleBaseUrl(secret.baseUrl)}/${path}`;
}

/**
 * A self-hosted OpenAI-compatible speech server (mlx-audio, Kokoro-FastAPI, Speaches)
 * at a user-supplied base URL. The `apiKey` argument carries the serialized
 * {@link OpenAiCompatibleVoiceSecret}, not a bare key.
 */
export class OpenAiCompatibleVoiceProvider implements VoiceProvider {
  private readonly fetch: typeof globalThis.fetch;

  constructor(options: { fetch?: typeof globalThis.fetch; allowPrivateEndpoint?: boolean } = {}) {
    this.fetch = createOpenAiCompatibleFetch(options.fetch, undefined, {
      allowPrivate: options.allowPrivateEndpoint,
    });
  }

  describe(): AdapterDescriptor<VoiceCapabilities> {
    return {
      id: OPENAI_COMPATIBLE_VOICE_PROVIDER_ID,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { catalog: true, synthesize: true, transcribe: true },
    };
  }

  /** GET /models proves reachability and the key; servers without it may still list voices. */
  async verify(apiKey: string, context: AdapterContext): Promise<VoiceVerifyResult> {
    let secret: OpenAiCompatibleVoiceSecret;
    try {
      secret = parseOpenAiCompatibleVoiceSecret(apiKey);
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
    const signal = voiceDeadline(context.signal, VERIFY_DEADLINE_MS);
    const origin = new URL(secret.baseUrl).origin;
    try {
      let res = await this.fetch(endpoint(secret, "models"), {
        headers: headers(secret),
        signal,
      });
      if (res.status === 404 || res.status === 405) {
        await res.body?.cancel().catch(() => undefined);
        res = await this.fetch(
          `${endpoint(secret, "audio/voices")}?model=${encodeURIComponent(secret.ttsModel)}`,
          { headers: headers(secret), signal },
        );
      }
      if (res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: true };
      }
      await res.body?.cancel().catch(() => undefined);
      return {
        ok: false,
        message: voiceHttpError(res.status, PROVIDER_NAME, "Checking the speech server", null),
      };
    } catch (error) {
      if (context.signal.aborted) throw error;
      return { ok: false, message: `Couldn't reach the speech server at ${origin}.` };
    }
  }

  async listVoices(apiKey: string, context: AdapterContext): Promise<VoiceInfo[]> {
    const secret = parseOpenAiCompatibleVoiceSecret(apiKey);
    try {
      const res = await this.fetch(
        `${endpoint(secret, "audio/voices")}?model=${encodeURIComponent(secret.ttsModel)}`,
        {
          headers: headers(secret),
          signal: voiceDeadline(context.signal, LIST_VOICES_DEADLINE_MS),
        },
      );
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return fallbackVoices(secret.ttsModel);
      }
      const voices = parseCompatibleVoiceList(await readVoiceJson(res));
      return voices.length ? voices : fallbackVoices(secret.ttsModel);
    } catch (error) {
      // A server that cannot list voices still speaks; a blocked address is a real error.
      if (context.signal.aborted || !(error instanceof Error) || !isNetworkError(error))
        throw error;
      return fallbackVoices(secret.ttsModel);
    }
  }

  async synthesize(request: VoiceSynthesizeRequest, context: AdapterContext): Promise<SpeechClip> {
    const secret = parseOpenAiCompatibleVoiceSecret(request.apiKey);
    const signal = voiceDeadline(request.signal ?? context.signal, SPEAK_DEADLINE_MS);
    const langCode = kokoroLangCode(request.voiceId);
    const res = await this.fetch(endpoint(secret, "audio/speech"), {
      method: "POST",
      headers: headers(secret, { "content-type": "application/json" }),
      body: JSON.stringify({
        model: secret.ttsModel,
        voice: request.voiceId,
        input: request.text,
        response_format: "mp3",
        // Kokoro servers otherwise read every voice with English pronunciation.
        ...(langCode ? { lang_code: langCode } : {}),
      }),
      signal,
    });
    if (!res.ok) throw serverError(res.status, "speaking", await readVoiceJson(res), secret.apiKey);
    const type = mediaType(res);
    // mp3 was requested; servers label it audio/mpeg or audio/mp3. Anything else is not a clip.
    if (type !== "audio/mpeg" && type !== "audio/mp3") {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`${PROVIDER_NAME} did not return MP3 audio.`);
    }
    return { bytes: await readVoiceAudio(res, signal), mimeType: "audio/mpeg" };
  }

  async transcribe(
    request: VoiceTranscribeRequest,
    context: AdapterContext,
  ): Promise<{ text: string }> {
    const secret = parseOpenAiCompatibleVoiceSecret(request.apiKey);
    const form = new FormData();
    form.set("model", secret.sttModel);
    // mlx-audio streams NDJSON unless asked for the OpenAI shape.
    form.set("response_format", "json");
    const language = voiceLanguageHint(request.language);
    if (language) form.set("language", language);
    form.set(
      "file",
      new Blob([new Uint8Array(request.audio)], { type: request.mimeType || "audio/webm" }),
      speechUploadName(request.mimeType),
    );
    const res = await this.fetch(endpoint(secret, "audio/transcriptions"), {
      method: "POST",
      headers: headers(secret),
      body: form,
      signal: voiceDeadline(request.signal ?? context.signal, TRANSCRIBE_DEADLINE_MS),
    });
    const raw = await readVoiceText(res);
    const type = mediaType(res);
    if (!res.ok) {
      throw serverError(res.status, "transcribing", parseJson(raw), secret.apiKey);
    }
    if (type && type !== "text/plain" && type !== "application/json") {
      throw new Error(`${PROVIDER_NAME} did not return a transcript.`);
    }
    const parsed = parseJson(raw);
    if (parsed && typeof parsed === "object") {
      return { text: String((parsed as { text?: unknown }).text ?? "").trim() };
    }
    // Anything else that is not labelled JSON is the transcript itself, even "1234" or "null".
    if (type === "application/json" || raw === null) {
      throw new Error(`${PROVIDER_NAME} did not return a transcript.`);
    }
    return { text: raw.trim() };
  }
}

function parseJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function mediaType(res: Response): string {
  return (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

function isNetworkError(error: Error): boolean {
  return error.name === "TypeError" || error.name === "AbortError" || error.name === "TimeoutError";
}
