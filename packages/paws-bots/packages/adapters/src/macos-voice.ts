import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { MAX_SPEAK_CHARS, MAX_SYNTHESIZED_AUDIO_BYTES } from "./voice-http.js";

export const MACOS_VOICE_PROVIDER_ID = "macos";
const SAY_BIN = "/usr/bin/say";

export const MACOS_VOICE_CATALOG_ENTRY = {
  id: MACOS_VOICE_PROVIDER_ID,
  name: "Server (Mac)",
  description: "Voices installed on the Mac running the server.",
  transcribe: false,
  keyless: true,
} as const;

const LIST_TIMEOUT_MS = 10_000;
const SPEAK_TIMEOUT_MS = 60_000;
const VOICE_CACHE_MS = 10 * 60_000;
const MAX_SAY_OUTPUT_CHARS = 256 * 1024;

/** Runs `say` with an args array (never a shell) and resolves its stdout. */
export type SayRunner = (
  args: string[],
  options: { input?: string; signal?: AbortSignal; timeoutMs: number },
) => Promise<string>;

let available: boolean | undefined;

export function macOsSayAvailable(): boolean {
  if (available !== undefined) return available;
  try {
    accessSync(SAY_BIN, constants.X_OK);
    available = process.platform === "darwin";
  } catch {
    available = false;
  }
  return available;
}

/** `Eddy (English (US))   en_US    # Hello!` keeps the full name; the locale is the description. */
export function parseSayVoices(output: string): VoiceInfo[] {
  const voices: VoiceInfo[] = [];
  for (const line of output.split("\n")) {
    const match = /^(.+?)\s+([a-z]{2,3}[_-][A-Za-z0-9_-]+)\s+#/.exec(line);
    const name = match?.[1]?.trim();
    if (!name || !match?.[2]) continue;
    voices.push({ id: name, label: name, description: match[2] });
  }
  const rank = (voice: VoiceInfo) => (/\((?:Premium|Enhanced)\)$/.test(voice.id) ? 0 : 1);
  return voices.sort((left, right) => rank(left) - rank(right));
}

/** `say` reads `[[…]]` as embedded commands; replies are spoken as plain text. */
function plainSpeech(text: string): string {
  return text.replace(/\[(?=\[)/g, "[ ");
}

type VoiceCache = { current?: { at: number; voices: Promise<VoiceInfo[]> } };

const sharedVoiceCache: VoiceCache = {};

export class MacOsVoiceProvider implements VoiceProvider {
  constructor(
    private readonly run: SayRunner = runSay,
    private readonly cache: VoiceCache = sharedVoiceCache,
  ) {}

  describe(): AdapterDescriptor<VoiceCapabilities> {
    return {
      id: MACOS_VOICE_PROVIDER_ID,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { catalog: true, synthesize: true, transcribe: false },
    };
  }

  async verify(_apiKey: string, _context: AdapterContext): Promise<VoiceVerifyResult> {
    const voices = await this.installedVoices().catch(() => []);
    return voices.length > 0 ? { ok: true } : { ok: false, message: "No voices are installed." };
  }

  listVoices(_apiKey: string, _context: AdapterContext): Promise<VoiceInfo[]> {
    return this.installedVoices();
  }

  async synthesize(request: VoiceSynthesizeRequest, context: AdapterContext): Promise<SpeechClip> {
    const text = request.text.trim();
    if (!text) throw new Error("Nothing to speak.");
    if (text.length > MAX_SPEAK_CHARS) throw new Error("That utterance is too long to speak.");
    const voices = await this.installedVoices();
    if (!voices.some((voice) => voice.id === request.voiceId)) {
      throw new Error("That voice is not installed on this Mac.");
    }
    const dir = await mkdtemp(join(tmpdir(), "rakazo-say-"));
    try {
      const file = join(dir, "speech.wav");
      await this.run(
        [
          "-v",
          request.voiceId,
          "--file-format=WAVE",
          "--data-format=LEI16@22050",
          "-o",
          file,
          "-f",
          "-",
        ],
        {
          input: plainSpeech(text),
          signal: request.signal ?? context.signal,
          timeoutMs: SPEAK_TIMEOUT_MS,
        },
      );
      if ((await stat(file)).size > MAX_SYNTHESIZED_AUDIO_BYTES) {
        throw new Error("Voice response is too large.");
      }
      return { bytes: new Uint8Array(await readFile(file)), mimeType: "audio/wav" };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private installedVoices(): Promise<VoiceInfo[]> {
    const cached = this.cache.current;
    if (cached && Date.now() - cached.at < VOICE_CACHE_MS) return cached.voices;
    const voices = this.run(["-v", "?"], { timeoutMs: LIST_TIMEOUT_MS }).then(parseSayVoices);
    const entry = { at: Date.now(), voices };
    this.cache.current = entry;
    // A failed listing is retried on the next call instead of being cached.
    voices.catch(() => {
      if (this.cache.current === entry) this.cache.current = undefined;
    });
    return voices;
  }
}

function runSay(
  args: string[],
  options: { input?: string; signal?: AbortSignal; timeoutMs: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)])
      : AbortSignal.timeout(options.timeoutMs);
    const child = spawn(SAY_BIN, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin" },
      signal,
      killSignal: "SIGKILL",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < MAX_SAY_OUTPUT_CHARS) stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 1024) stderr += chunk;
    });
    child.on("error", (error) =>
      reject(signal.aborted ? new Error("macOS speech timed out or was cancelled.") : error),
    );
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim().slice(0, 200) || `macOS say exited with ${code}.`));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input ?? "");
  });
}
