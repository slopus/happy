import { pawsFetch } from "../paws/runtime";
import { t } from "@lingui/core/macro";
import {
  cancelResponseBody,
  MAX_TRANSCRIPTION_RESPONSE_BYTES,
  readJsonObjectWithin,
  recognitionLocaleTag,
  speechLocaleTag,
  VOICE_RESPONSE_TIMEOUT_MS,
  withAbort,
} from "@rakazo/core";
import { desktopBridge } from "./desktop.js";
import { DesktopSpeechRecognition } from "./desktop-speech.js";
import { getActiveUiLocale } from "./i18n.js";
import { selectedSpaceId, withSpaceHeaders } from "./rpc.js";
import { errorText, voiceAccountErrorText } from "./user-error.js";

export type DictationMode = "hold" | "endpoint";

export type DictationSnapshot = {
  status: "idle" | "listening" | "transcribing";
  transcript: string;
  error?: string;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { resultIndex: number; results: SpeechRecognitionResultList }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

const IDLE: DictationSnapshot = { status: "idle", transcript: "" };
/**
 * Quiet gap that ends an utterance, measured on the page. Chrome's own end-of-speech
 * fires on any pause, which cuts a caller off mid-sentence; a natural breath is well
 * under this, a finished turn is well over it.
 */
const ENDPOINT_SILENCE_MS = 1200;
const ENDPOINT_TICK_MS = 80;
const SILENCE_RMS = 0.035;
export const MAX_ENDPOINT_RECORDING_MS = 30_000;
/** Web Speech codes that mean the cloud recognizer cannot be used. */
const WEB_SPEECH_SERVICE_ERRORS = new Set(["network", "service-not-allowed"]);

export function webSpeechAvailable(): boolean {
  return Boolean(speechRecognitionCtor());
}

/**
 * Electron exposes webkitSpeechRecognition without a speech-service key, so
 * recognition fails with `network`. Don't treat that API as available there.
 */
function electronSpeechHost(): boolean {
  if (typeof window !== "undefined") {
    const host = window as Window & { rakazoDesktop?: unknown };
    if (host.rakazoDesktop) return true;
  }
  if (typeof navigator === "undefined") return false;
  const agent = navigator.userAgent;
  return typeof agent === "string" && agent.includes("Electron");
}

/**
 * Phones cannot hold a speech session open: `start()` replays the system tone on every
 * restart and the session ends at each pause, so Web Speech there means one beep per
 * phrase and a transcript that keeps getting cut. Server transcription records silently,
 * so prefer it on mobile browsers wherever a provider can transcribe.
 */
export function prefersServerDictation(): boolean {
  if (typeof navigator === "undefined") return false;
  const agent = typeof navigator.userAgent === "string" ? navigator.userAgent : "";
  if (/android|iphone|ipod|ipad|mobile/i.test(agent)) return true;
  // iPadOS 13+ reports a desktop Safari user agent, so fall back to touch support.
  const touchPoints = typeof navigator.maxTouchPoints === "number" ? navigator.maxTouchPoints : 0;
  return touchPoints > 1 && /macintosh/i.test(agent);
}

export function usesServerDictation(transcribe: boolean | undefined): boolean {
  return (
    (prefersServerDictation() && transcribe !== false) ||
    Boolean(desktopBridge()?.speech && transcribe) ||
    (!webSpeechAvailable() && Boolean(transcribe))
  );
}

/** Connected server transcription should take over after Web Speech cannot run. */
export function webSpeechNeedsServerFallback(
  error: string | undefined,
  transcribe: boolean,
): boolean {
  return transcribe && typeof error === "string" && WEB_SPEECH_SERVICE_ERRORS.has(error);
}

/**
 * Web Speech ends the session on its own, and every start() plays the recognizer's tone.
 * When the browser cannot hold the microphone the sessions end the moment they begin, so
 * an immediate restart turns into a stream of beeps. Back off, then hand the microphone
 * over instead of hammering it.
 */
const RESTART_SHORT_SESSION_MS = 400;
const RESTART_BACKOFF_AFTER = 2;
const RESTART_BACKOFF_MS = 900;
const RESTART_GIVE_UP_AFTER = 4;

/** English UI follows the browser; other UI languages keep matching regional variants. */
export function recognitionLanguage(): string {
  return recognitionLocaleTag(getActiveUiLocale(), navigator.language);
}

/**
 * Language hint for server transcription: the primary subtag of the app's own locale
 * (`es`, `pt`, `zh`). Undefined leaves detection to the provider.
 */
export function transcriptionLanguage(): string | undefined {
  const tag = speechLocaleTag(getActiveUiLocale());
  return tag ? tag.split("-")[0]?.toLowerCase() : undefined;
}

function normalizedTranscript(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function startsWithWholePrefix(text: string, prefix: string): boolean {
  const head = prefix.toLowerCase();
  const tail = text.toLowerCase();
  if (!tail.startsWith(head)) return false;
  // Index by code point. A supplementary-plane letter is two UTF-16 units, and
  // the first half alone is not a letter.
  const point = tail.codePointAt(head.length);
  if (point === undefined) return true;
  // Punctuation ends the retained word. Letters, numbers, and "_" continue it.
  return !/[\p{L}\p{N}_]/u.test(String.fromCodePoint(point));
}

/** Join carried Web Speech with a restarted session at their longest whole-word overlap. */
export function combineTranscript(prefix: string, speechText: string): string {
  const head = normalizedTranscript(prefix);
  const tail = speechText.trim();
  if (!head) return tail;
  if (!tail) return head;
  if (startsWithWholePrefix(tail, head)) return tail;
  const normalizedTail = normalizedTranscript(tail);
  for (let start = 0; start < head.length; start += 1) {
    if (start > 0 && !/\s/u.test(head[start - 1] ?? "")) continue;
    const overlap = head.slice(start);
    if (startsWithWholePrefix(normalizedTail, overlap)) {
      return head.slice(0, start) + normalizedTail;
    }
  }
  return `${head} ${normalizedTail}`;
}

function speechRecognitionCtor(): SpeechRecognitionCtor | undefined {
  if (typeof window === "undefined") return undefined;
  // The desktop app listens through the operating system's recognizer instead.
  if (desktopBridge()?.speech) return DesktopSpeechRecognition;
  if (electronSpeechHost()) return undefined;
  const host = window as Window & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return host.SpeechRecognition ?? host.webkitSpeechRecognition;
}

function audioContextCtor(): (new () => AudioContext) | undefined {
  if (typeof AudioContext === "function") return AudioContext;
  if (typeof window === "undefined") return undefined;
  const host = window as Window & { webkitAudioContext?: typeof AudioContext };
  return host.webkitAudioContext;
}

export class Dictation {
  private snapshot: DictationSnapshot = IDLE;
  private watchers = new Set<(s: DictationSnapshot) => void>();
  private recognition: SpeechRecognitionLike | null = null;
  private media: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private token = 0;
  private silenceTimer: ReturnType<typeof setTimeout> | undefined;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private transcribeAbort: AbortController | null = null;
  private audioContext: AudioContext | null = null;
  private vadTimer: ReturnType<typeof setInterval> | undefined;
  private speechSamples = 0;
  private sampleInput: (() => boolean) | undefined;
  private heardSpeech = false;
  private onFinal: ((text: string) => void) | null = null;
  /** Mode of the running session: an endpoint turn reports back even without words. */
  private mode: DictationMode | null = null;

  subscribe(fn: (s: DictationSnapshot) => void): () => void {
    this.watchers.add(fn);
    fn(this.snapshot);
    return () => {
      this.watchers.delete(fn);
    };
  }

  get state(): DictationSnapshot {
    return this.snapshot;
  }

  get recording(): boolean {
    return this.media?.state === "recording";
  }

  private set(next: DictationSnapshot) {
    this.snapshot = next;
    for (const watcher of [...this.watchers]) watcher(next);
  }

  stop(reason: "submit" | "cancel" | "replace" = "cancel") {
    this.token += 1;
    this.transcribeAbort?.abort();
    this.transcribeAbort = null;
    this.stopVad();
    clearTimeout(this.silenceTimer);
    this.silenceTimer = undefined;
    clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    const rec = this.recognition;
    this.recognition = null;
    if (rec) {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try {
        if (reason === "submit") rec.stop();
        else rec.abort();
      } catch {
        // already stopped
      }
    }
    const media = this.media;
    this.media = null;
    if (media && media.state !== "inactive") {
      try {
        media.stop();
      } catch {
        // already stopped
      }
    }
    this.chunks = [];
    this.speechSamples = 0;
    this.heardSpeech = false;
    this.onFinal = null;
    this.mode = null;
    if (this.snapshot.status !== "idle" || this.snapshot.error) this.set(IDLE);
  }

  async listen(opts: {
    mode: DictationMode;
    transcribe?: boolean;
    endpointMs?: number;
    onFinal: (text: string) => void;
  }): Promise<void> {
    this.stop("replace");
    const mine = this.token;
    const spaceId = selectedSpaceId();
    this.onFinal = opts.onFinal;
    this.mode = opts.mode;
    this.set({ status: "listening", transcript: "" });
    const transcribe = Boolean(opts.transcribe);
    // Desktop system speech is a fallback for an unconfigured transcription provider.
    // An unknown capability is not a refusal: a device whose browser cannot hold the
    // microphone open goes to the server even before the voice status has loaded.
    if (usesServerDictation(opts.transcribe)) {
      await this.listenRecorder(mine, opts.mode, opts.endpointMs ?? ENDPOINT_SILENCE_MS, spaceId);
      return;
    }
    if (webSpeechAvailable()) {
      this.listenWebSpeech(
        opts.mode,
        opts.endpointMs ?? ENDPOINT_SILENCE_MS,
        mine,
        transcribe,
        spaceId,
      );
      return;
    }
    this.set({
      ...IDLE,
      error: t`This browser has no on-device dictation. Connect a voice provider with transcription, or use Chrome / the desktop app.`,
    });
  }

  private listenWebSpeech(
    mode: DictationMode,
    endpointMs: number,
    mine: number,
    transcribe: boolean,
    spaceId: string | null,
  ) {
    const Ctor = speechRecognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    let live = true;
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = recognitionLanguage();
    // Chrome numbers results per session, so a restart starts over: keep the earlier text.
    let carried = "";
    let sessionStartedAt = Date.now();
    let shortSessions = 0;
    let sessionHeardSpeech = false;
    rec.onresult = (event) => {
      if (!live || this.token !== mine) return;
      // Each result index is a separate phrase. Matching text within this session
      // may be a real repetition; only deduplicate against a previous session.
      const session = normalizedTranscript(
        Array.from(event.results, (result) => result?.[0]?.transcript ?? "").join(" "),
      );
      if (session.trim()) {
        sessionHeardSpeech = true;
        shortSessions = 0;
      }
      const transcript = combineTranscript(carried, session);
      this.set({ status: "listening", transcript });
      if (mode !== "endpoint") return;
      // Every result means the caller was just heard, so the quiet gap is measured from
      // here. That includes Chrome finalising a phrase it already reported: its phrase
      // boundary is a breath, and the words repeat, so a window tied to new text alone
      // expires before Chrome opens its first interim for the rest of the sentence.
      if (!transcript) return;
      clearTimeout(this.silenceTimer);
      this.silenceTimer = setTimeout(() => {
        if (!live || this.token !== mine) return;
        this.finish(this.snapshot.transcript, mine);
      }, endpointMs);
    };
    rec.onerror = (event) => {
      if (!live || this.token !== mine) return;
      if (event.error === "aborted" || event.error === "no-speech") return;
      if (webSpeechNeedsServerFallback(event.error, transcribe)) {
        live = false;
        this.fallbackToServer(rec, mine, mode, endpointMs, spaceId);
        return;
      }
      live = false;
      const code = event.error;
      this.set({
        ...IDLE,
        error:
          // macOS asks only once; after a refusal, only System Settings can allow it again.
          code === "not-allowed" && desktopBridge()?.speech
            ? t`Allow Rakazo to use Speech Recognition and the microphone in System Settings.`
            : code
              ? t`Dictation failed: ${code}`
              : t`Dictation failed.`,
      });
    };
    rec.onend = () => {
      if (!live || this.token !== mine) return;
      if (this.snapshot.status !== "listening") return;
      if (mode === "hold") {
        this.finish(this.snapshot.transcript, mine);
        return;
      }
      // Chrome ends the session on its own — after a pause, or its ~60s cap — and that
      // says nothing about whether the caller finished. Only the silence window above
      // ends an utterance; here we just pick the microphone back up — unless it keeps
      // ending straight away, which means the browser cannot hold the microphone at all.
      carried = this.snapshot.transcript;
      shortSessions =
        !sessionHeardSpeech && Date.now() - sessionStartedAt < RESTART_SHORT_SESSION_MS
          ? shortSessions + 1
          : 0;
      if (shortSessions >= RESTART_GIVE_UP_AFTER) {
        live = false;
        if (transcribe) {
          this.fallbackToServer(rec, mine, mode, endpointMs, spaceId);
          return;
        }
        this.releaseRecognition(rec);
        this.failListening(
          mine,
          t`The browser keeps dropping the microphone. Start dictation again to retry.`,
          true,
        );
        return;
      }
      const restart = () => {
        if (!live || this.token !== mine) return;
        try {
          sessionStartedAt = Date.now();
          sessionHeardSpeech = false;
          rec.start();
        } catch {
          this.set({ ...IDLE, error: t`Dictation ended unexpectedly.` });
        }
      };
      if (shortSessions >= RESTART_BACKOFF_AFTER) {
        this.restartTimer = setTimeout(restart, RESTART_BACKOFF_MS);
        return;
      }
      restart();
    };
    this.recognition = rec;
    try {
      sessionStartedAt = Date.now();
      rec.start();
    } catch {
      if (!live || this.token !== mine) return;
      if (transcribe) {
        live = false;
        this.fallbackToServer(rec, mine, mode, endpointMs, spaceId);
        return;
      }
      live = false;
      this.releaseRecognition(rec);
      this.set({ ...IDLE, error: t`Dictation failed.` });
    }
  }

  private fallbackToServer(
    rec: SpeechRecognitionLike,
    mine: number,
    mode: DictationMode,
    endpointMs: number,
    spaceId: string | null,
  ) {
    const recognized = normalizedTranscript(this.snapshot.transcript);
    this.releaseRecognition(rec);
    clearTimeout(this.silenceTimer);
    this.silenceTimer = undefined;
    if (this.token !== mine) return;
    this.set({ status: "listening", transcript: recognized });
    void this.listenRecorder(mine, mode, endpointMs, spaceId);
  }

  private releaseRecognition(rec: SpeechRecognitionLike) {
    rec.onresult = null;
    rec.onerror = null;
    rec.onend = null;
    if (this.recognition === rec) this.recognition = null;
    try {
      rec.abort();
    } catch {
      // already stopped
    }
  }

  private async listenRecorder(
    mine: number,
    mode: DictationMode,
    endpointMs: number,
    spaceId: string | null,
  ) {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (error) {
      this.failListening(mine, errorText(error, t`Microphone failed`));
      return;
    }
    if (this.token !== mine) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    const keptSpeech = this.snapshot.transcript.trim().length > 0;
    this.speechSamples = 0;
    this.heardSpeech = keptSpeech;
    const endpoint = mode === "endpoint";
    const monitoring = this.monitorInput(stream, mine, endpoint ? endpointMs : undefined);
    if (endpoint && !monitoring) {
      for (const track of stream.getTracks()) track.stop();
      this.failListening(
        mine,
        t`This browser can't detect when you stop talking. Use Chrome, the desktop app, or hold-to-talk in the composer.`,
      );
      return;
    }
    let media: MediaRecorder | undefined;
    try {
      media = new MediaRecorder(stream);
      this.media = media;
      this.chunks = [];
      media.ondataavailable = (event) => {
        if (this.token !== mine) return;
        if (event.data.size) this.chunks.push(event.data);
      };
      media.onstop = () => {
        if (this.token === mine) this.sampleInput?.();
        for (const track of stream.getTracks()) track.stop();
        if (this.token !== mine) return;
        this.stopVad();
        void this.transcribeChunks(mine, spaceId);
      };
      media.start(mode === "endpoint" ? 250 : undefined);
      this.set({ ...this.snapshot });
    } catch (error) {
      if (media) {
        media.ondataavailable = null;
        media.onstop = null;
      }
      for (const track of stream.getTracks()) track.stop();
      if (this.media === media) this.media = null;
      if (this.token !== mine) return;
      this.stopVad();
      this.failListening(mine, errorText(error, t`Dictation failed.`));
    }
  }

  /**
   * Watches the microphone level so a recording that never rose above the speech
   * threshold is not sent to a transcription model, which invents text for silence.
   * Endpoint mode also uses it to end the turn after a quiet gap; `endpointMs` is
   * undefined in hold mode, where the caller's release ends the turn.
   */
  private monitorInput(stream: MediaStream, mine: number, endpointMs: number | undefined): boolean {
    const Ctor = audioContextCtor();
    if (!Ctor) return false;
    try {
      const ctx = new Ctor();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      this.audioContext = ctx;
      if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
      const data = new Uint8Array(analyser.fftSize);
      this.sampleInput = () => {
        if (this.token !== mine || ctx.state !== "running") return false;
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const sample of data) {
          const n = (sample - 128) / 128;
          sum += n * n;
        }
        this.speechSamples += 1;
        const speech = Math.sqrt(sum / data.length) > SILENCE_RMS;
        if (speech) this.heardSpeech = true;
        return speech;
      };
      let silentFor = 0;
      const startedAt = Date.now();
      this.vadTimer = setInterval(() => {
        const media = this.media;
        if (this.token !== mine || !media || media.state === "inactive") return;
        const speaking = this.sampleInput?.();
        const full =
          endpointMs !== undefined && Date.now() - startedAt >= MAX_ENDPOINT_RECORDING_MS;
        if (full && !this.heardSpeech) {
          this.finish(this.snapshot.transcript, mine);
          return;
        }
        if (!full) {
          if (speaking) {
            silentFor = 0;
            return;
          }
          if (endpointMs === undefined || !this.heardSpeech) return;
          silentFor += ENDPOINT_TICK_MS;
          if (silentFor < endpointMs) return;
        }
        this.stopVad();
        try {
          media.stop();
        } catch {
          // already stopped
        }
      }, ENDPOINT_TICK_MS);
      return true;
    } catch {
      this.stopVad();
      return false;
    }
  }

  private stopVad() {
    clearInterval(this.vadTimer);
    this.vadTimer = undefined;
    this.sampleInput = undefined;
    const ctx = this.audioContext;
    this.audioContext = null;
    if (ctx) void ctx.close().catch(() => undefined);
  }

  private async transcribeChunks(mine: number, spaceId: string | null) {
    if (this.token !== mine) return;
    // Whisper-style models invent text for silence, so a recording that never rose above
    // the speech threshold is not sent. Require multiple running-context readings so
    // a quick release with only a final sample still gets transcribed.
    if (this.speechSamples >= 2 && !this.heardSpeech) {
      this.chunks = [];
      this.media = null;
      const prefix = normalizedTranscript(this.snapshot.transcript);
      if (prefix) {
        this.finish(prefix, mine);
        return;
      }
      this.set({ ...IDLE, error: t`Didn't catch that.` });
      return;
    }
    const blob = new Blob(this.chunks, { type: this.chunks[0]?.type || "audio/webm" });
    this.chunks = [];
    if (!blob.size) {
      this.finish(normalizedTranscript(this.snapshot.transcript), mine);
      return;
    }
    this.set({ status: "transcribing", transcript: this.snapshot.transcript });
    const abort = new AbortController();
    this.transcribeAbort = abort;
    const timedOutMessage = t`Transcription request timed out.`;
    const couldNotTranscribe = t`Could not transcribe that recording.`;
    const timer = setTimeout(
      () => abort.abort(new Error(timedOutMessage)),
      VOICE_RESPONSE_TIMEOUT_MS,
    );
    try {
      const audioBase64 = await blobToBase64(blob);
      if (this.token !== mine) return;
      const res = await withAbort(
        pawsFetch("/api/voice/transcribe", {
          method: "POST",
          headers: withSpaceHeaders({ "content-type": "application/json" }, spaceId),
          credentials: "include",
          body: JSON.stringify({
            audioBase64,
            mimeType: blob.type,
            language: transcriptionLanguage(),
          }),
          signal: abort.signal,
        }),
        abort.signal,
      );
      if (this.token !== mine) {
        cancelResponseBody(res);
        return;
      }
      const body = await readTranscriptionBody(res, abort.signal);
      if (this.token !== mine) return;
      if (!res.ok) {
        this.failListening(mine, voiceAccountErrorText(body) ?? body.error ?? couldNotTranscribe);
        return;
      }
      // The recorder captures fresh audio, so matching words are intentional repetitions.
      const prefix = normalizedTranscript(this.snapshot.transcript);
      const text = body.text ?? "";
      this.finish(
        prefix ? [prefix, normalizedTranscript(text)].filter(Boolean).join(" ") : text,
        mine,
      );
    } catch (error) {
      // User cancel bumps token in stop() before aborting, so a matching token
      // means the deadline timer fired. Browsers may reject fetch as AbortError
      // instead of signal.reason; surface the timeout either way.
      if (this.token !== mine) return;
      if (abort.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        this.failListening(mine, timedOutMessage);
        return;
      }
      this.failListening(mine, errorText(error, couldNotTranscribe));
    } finally {
      clearTimeout(timer);
      if (this.transcribeAbort === abort) this.transcribeAbort = null;
    }
  }

  submitHold() {
    if (this.media && this.media.state !== "inactive") {
      this.media.stop();
      return;
    }
    this.finish(this.snapshot.transcript, this.token);
  }

  private failListening(mine: number, message: string, showError = false) {
    if (this.token !== mine) return;
    const prefix = normalizedTranscript(this.snapshot.transcript);
    if (prefix) {
      this.finish(prefix, mine, showError ? message : undefined);
      return;
    }
    this.set({ ...IDLE, error: message });
  }

  private finish(text: string, mine: number, error?: string) {
    if (this.token !== mine) return;
    const trimmed = text.trim();
    const onFinal = this.onFinal;
    const mode = this.mode;
    this.stop("submit");
    if (error) this.set({ ...IDLE, error });
    if (trimmed) onFinal?.(trimmed);
    // An endpoint session ends with the attempt, words or not. Report the empty turn
    // too, so a caller holding the microphone open starts the next attempt; hold mode
    // watches for idle itself.
    else if (mode === "endpoint") onFinal?.("");
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function readTranscriptionBody(response: Response, signal: AbortSignal) {
  return readJsonObjectWithin<{ text?: string; error?: string; code?: string }>(response, {
    maxBytes: MAX_TRANSCRIPTION_RESPONSE_BYTES,
    tooLargeMessage: t`Transcription response is too large.`,
    signal,
  });
}

export const dictation = new Dictation();
