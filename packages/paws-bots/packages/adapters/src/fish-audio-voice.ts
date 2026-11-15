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
import { getLogger } from "@rakazo/logging";
import {
  isSpeechModelId,
  readVoiceAudio,
  readVoiceJson,
  speechUploadName,
  verifyVoiceHttpGet,
  voiceDeadline,
  voiceLanguageHint,
  voiceRequestError,
} from "./voice-http.js";

const API = "https://api.fish.audio";
const MODEL_PAGE_SIZE = 100;
/** Top-scored public voices for the picker — not a full catalog crawl. */
const PUBLIC_MODEL_PAGES = 5;
const PUBLIC_MODEL_CONCURRENCY = 2;
/** User-owned libraries are smaller; still hard-capped. */
const OWN_MODEL_PAGES = 20;
const LIST_VOICES_DEADLINE_MS = 20_000;
const DEFAULT_TTS_MODEL = "s2.1-pro";
const UPSTREAM_DETAIL_LIMIT = 500;
let invalidTtsModelWarned = false;
/**
 * Fish's recommended, multilingual ASR model. Without the `model` header the endpoint
 * serves the older `transcribe-1`, which reads most languages as English lookalikes.
 */
const DEFAULT_ASR_MODEL = "transcribe-1-pro";
/** BCP-47 tag or ISO 639-1 code; Fish wants the lowercase primary subtag. */
let invalidAsrModelWarned = false;

export class FishAudioVoiceProvider implements VoiceProvider {
  describe(): AdapterDescriptor<VoiceCapabilities> {
    return {
      id: "fish-audio",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { catalog: true, synthesize: true, transcribe: true, languages: true },
    };
  }

  async verify(apiKey: string, context: AdapterContext): Promise<VoiceVerifyResult> {
    return verifyVoiceHttpGet({
      url: `${API}/model?page_size=1&page_number=1`,
      headers: fishAudioHeaders(apiKey),
      signal: context.signal,
      provider: "Fish Audio",
    });
  }

  /** Return user-owned then bounded public Fish Audio voices as Rakazo choices. */
  async listVoices(
    apiKey: string,
    context: AdapterContext,
    options: { language?: string } = {},
  ): Promise<VoiceInfo[]> {
    const controller = new AbortController();
    const signal = voiceDeadline(
      AbortSignal.any([context.signal, controller.signal]),
      LIST_VOICES_DEADLINE_MS,
    );
    const listContext = { ...context, signal };
    // Fish's catalog filter matches the lowercase primary subtag ("de-DE" → "de").
    const language = options.language?.split("-")[0]?.toLowerCase() || undefined;
    try {
      const [publicModels, ownModels] = await Promise.all([
        fetchModels(apiKey, listContext, false, language),
        fetchModels(apiKey, listContext, true, undefined),
      ]);
      const seen = new Set<string>();
      return [...ownModels, ...publicModels]
        .map(modelToVoice)
        .filter((voice): voice is VoiceInfo => {
          if (!voice || seen.has(voice.id)) return false;
          seen.add(voice.id);
          return true;
        });
    } finally {
      // Stop sibling or speculative requests when the listing finishes or fails.
      controller.abort();
    }
  }

  async synthesize(request: VoiceSynthesizeRequest, context: AdapterContext): Promise<SpeechClip> {
    const signal = voiceDeadline(request.signal ?? context.signal, 60_000);
    const model = resolveFishSpeechModel(request.model);
    const res = await fetch(`${API}/v1/tts`, {
      method: "POST",
      headers: {
        ...fishAudioHeaders(request.apiKey),
        "content-type": "application/json",
        accept: "audio/mpeg",
        model,
      },
      body: JSON.stringify({
        text: request.text,
        reference_id: request.voiceId,
        format: "mp3",
        mp3_bitrate: 64,
        latency: "balanced",
        normalize: true,
      }),
      signal,
    });
    if (!res.ok) {
      rejectFish(res.status, "speaking", await readFishResponse(res), request.apiKey, model);
    }
    return { bytes: await readVoiceAudio(res, signal), mimeType: "audio/mpeg" };
  }

  async transcribe(
    request: VoiceTranscribeRequest,
    context: AdapterContext,
  ): Promise<{ text: string }> {
    const form = new FormData();
    form.set(
      "audio",
      new Blob([new Uint8Array(request.audio)], { type: request.mimeType || "audio/webm" }),
      speechUploadName(request.mimeType),
    );
    form.set("ignore_timestamps", "true");
    // transcribe-1-pro otherwise leaves bracketed audio events ("[risas]") in the text.
    form.set("tag_audio_events", "false");
    const language = voiceLanguageHint(request.language);
    if (language) form.set("language", language);
    const model = resolveFishTranscriptionModel();
    const res = await fetch(`${API}/v1/asr`, {
      method: "POST",
      headers: { ...fishAudioHeaders(request.apiKey), model },
      body: form,
      signal: voiceDeadline(request.signal ?? context.signal, 60_000),
    });
    const body = await readFishResponse(res);
    if (!res.ok) rejectFish(res.status, "transcribing", body, request.apiKey);
    return { text: stripFishAsrTags(String((body as { text?: unknown } | null)?.text ?? "")) };
  }
}

async function fetchModels(
  apiKey: string,
  context: AdapterContext,
  own: boolean,
  language?: string,
): Promise<Array<Record<string, unknown>>> {
  const maxPages = own ? OWN_MODEL_PAGES : PUBLIC_MODEL_PAGES;
  const models: Array<Record<string, unknown>> = [];
  let pageNumber = 1;
  let batchSize = 1;
  while (pageNumber <= maxPages) {
    // Only prefetch public pages backed by a known total, within the existing cap.
    const pending = Array.from({ length: Math.min(batchSize, maxPages - pageNumber + 1) }, (_, i) =>
      fetchModelPage(apiKey, context, own, pageNumber + i, language).then(
        (page) => ({ page }),
        (error: unknown) => ({ error }),
      ),
    );
    for (const request of pending) {
      const result = await request;
      context.signal.throwIfAborted();
      if ("error" in result) throw result.error;
      const { body, ok, status } = result.page;
      if (!ok) rejectFish(status, "listing voices", body, apiKey);
      const items = modelsFrom(body);
      models.push(...items);
      if (items.length === 0 || !modelPageHasMore(body, pageNumber, items.length)) return models;
      pageNumber++;
      const total = (body as { total?: unknown } | null)?.total;
      batchSize =
        !own && typeof total === "number" && Number.isFinite(total)
          ? Math.min(
              PUBLIC_MODEL_CONCURRENCY,
              Math.max(1, Math.ceil(total / MODEL_PAGE_SIZE) - pageNumber + 1),
            )
          : 1;
    }
  }
  return models;
}

/** Read one page; classify HTTP errors only if the ordered walk still needs it. */
async function fetchModelPage(
  apiKey: string,
  context: AdapterContext,
  own: boolean,
  pageNumber: number,
  language?: string,
) {
  context.signal.throwIfAborted();
  const params = new URLSearchParams({
    page_size: String(MODEL_PAGE_SIZE),
    page_number: String(pageNumber),
    sort_by: "score",
  });
  if (own) params.set("self", "true");
  else if (language) params.set("language", language);
  const res = await fetch(`${API}/model?${params}`, {
    headers: fishAudioHeaders(apiKey),
    signal: context.signal,
  });
  return { body: await readFishResponse(res), ok: res.ok, status: res.status };
}

function modelPageHasMore(body: unknown, pageNumber: number, itemCount: number): boolean {
  if (!body || typeof body !== "object") return false;
  const meta = body as { has_more?: unknown; total?: unknown };
  if (typeof meta.has_more === "boolean") return meta.has_more;
  if (typeof meta.total === "number" && Number.isFinite(meta.total)) {
    return pageNumber * MODEL_PAGE_SIZE < meta.total;
  }
  return itemCount === MODEL_PAGE_SIZE;
}

function fishAudioHeaders(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}` };
}

/**
 * `FISH_ASR_MODEL` when it is a model id, otherwise transcribe-1-pro. A deployment that
 * pins another speech model keeps it; anything unparseable falls back rather than
 * sending a header Fish would reject.
 */
function resolveFishTranscriptionModel(): string {
  const configured = process.env.FISH_ASR_MODEL?.trim() ?? "";
  if (!configured) return DEFAULT_ASR_MODEL;
  if (isSpeechModelId(configured)) return configured;
  if (!invalidAsrModelWarned) {
    invalidAsrModelWarned = true;
    getLogger().warn("Ignoring FISH_ASR_MODEL because it is not a model id", {
      provider: "fish-audio",
    });
  }
  return DEFAULT_ASR_MODEL;
}

/**
 * `transcribe-1-pro` marks speaker turns inline (`<|speaker:0|>`) on every response.
 * Dictation wants the words only, so drop the control markers.
 */
export function stripFishAsrTags(text: string): string {
  return text
    .replace(/<\|[^|>]*\|>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Connection override, then `FISH_TTS_MODEL`, then s2.1-pro. */
function resolveFishSpeechModel(override?: string | null): string {
  const requested = override?.trim() ?? "";
  if (requested && isSpeechModelId(requested)) return requested;
  return deploymentFishSpeechModel();
}

/** `FISH_TTS_MODEL` when it is a single model id; otherwise s2.1-pro. */
function deploymentFishSpeechModel(): string {
  const configured = process.env.FISH_TTS_MODEL?.trim() ?? "";
  if (!configured) return DEFAULT_TTS_MODEL;
  if (isSpeechModelId(configured)) return configured;
  if (!invalidTtsModelWarned) {
    invalidTtsModelWarned = true;
    getLogger().warn("Ignoring FISH_TTS_MODEL because it is not a model id", {
      provider: "fish-audio",
    });
  }
  return DEFAULT_TTS_MODEL;
}

/** Read a Fish body. Error responses still return a safe message when the read fails. */
async function readFishResponse(res: Response): Promise<unknown> {
  try {
    return await readVoiceJson(res, { requireValid: res.ok, rawOnInvalid: !res.ok });
  } catch (error) {
    if (res.ok) throw error;
    return fishUnreadBody(error);
  }
}

function fishUnreadBody(error: unknown): { message: string } {
  if (error instanceof Error && error.message === "Voice response is too large.") {
    return { message: error.message };
  }
  return { message: "response body could not be read" };
}

function rejectFish(
  status: number,
  what: string,
  body: unknown,
  apiKey: string,
  model?: string,
): never {
  const detail = fishErrorDetail(body, apiKey);
  const error = voiceRequestError(
    status,
    "Fish Audio",
    what,
    typeof body === "string" || !detail ? null : { message: detail },
  );
  // Spent credit or a rejected key is the user's account to fix, not a server fault.
  getLogger()[error instanceof VoiceAccountError ? "warn" : "error"]("Fish Audio request failed", {
    provider: "fish-audio",
    operation: what,
    "http.status": status,
    ...(model ? { "fish.model": model } : {}),
    ...(detail ? { "error.detail": detail } : {}),
  });
  throw error;
}

/** Upstream message, or a short raw body when Fish did not return JSON. */
function fishErrorDetail(body: unknown, apiKey: string): string {
  const text = typeof body === "string" ? body : upstreamMessage(body) || jsonFallback(body);
  return scrubSecret(text, apiKey).replace(/\s+/g, " ").trim().slice(0, UPSTREAM_DETAIL_LIMIT);
}

function upstreamMessage(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  for (const key of ["detail", "message", "error"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (
      value &&
      typeof value === "object" &&
      typeof (value as { message?: unknown }).message === "string"
    ) {
      const message = (value as { message: string }).message.trim();
      if (message) return message;
    }
  }
  return "";
}

function jsonFallback(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  try {
    return JSON.stringify(body);
  } catch {
    return "";
  }
}

function scrubSecret(text: string, apiKey: string): string {
  const secret = apiKey.trim();
  if (secret.length < 8) return text;
  return text.split(secret).join("[Redacted]");
}

function modelsFrom(body: unknown): Array<Record<string, unknown>> {
  if (!body || typeof body !== "object") return [];
  const items = (body as { items?: unknown }).items;
  return Array.isArray(items)
    ? items.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === "object"),
      )
    : [];
}

function modelToVoice(model: Record<string, unknown>): VoiceInfo | null {
  if (model.dmca_taken_down === true || model.state === "failed") return null;
  const id = asText(model._id) || asText(model.id);
  if (!id) return null;
  const label = asText(model.title) || asText(model.name) || "Voice";
  const description =
    [asText(model.description), languageLabel(model.languages)].filter(Boolean).join(" · ") ||
    undefined;
  return { id, label, description };
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function languageLabel(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .join(", ");
}
