import { LOCAL_PROVIDER_ID } from "./pi-local-provider-id.js";

/**
 * A client-side sliding-window pacer for a local model server that rejects input over a
 * per-minute prompt-token limit (a rate-limited key, a free tier, an organisation quota). Such a
 * server answers 429 with a fixed Retry-After, so each rejection costs about a minute; the pacer
 * instead waits only until enough of the window has expired. A 429 that still happens (another
 * client shares the key) keeps the usual Retry-After handling.
 */

/** Prompt tokens per minute the local provider may send. Unset means no pacing. */
export const LOCAL_TOKENS_PER_MINUTE_ENV = "RAKAZO_LOCAL_TOKENS_PER_MINUTE";
const WINDOW_MS = 60_000;
const SLACK_MS = 50;

/** The configured limit for a provider, or undefined when it is not paced. */
export function pacerTokensPerMinute(
  providerId: string,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  if (providerId !== LOCAL_PROVIDER_ID) return undefined;
  const raw = env[LOCAL_TOKENS_PER_MINUTE_ENV]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${LOCAL_TOKENS_PER_MINUTE_ENV} must be a positive integer, received "${raw}"`);
  }
  return value;
}

export interface PacerSlot {
  /** Replace the estimate with the prompt tokens the server reported. */
  settle(actualTokens: number): void;
  /** The call was rejected or never reached the server: free its share of the window. */
  release(): void;
}

interface Entry {
  at: number;
  tokens: number;
}

export interface TokenPacerClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

const realClock: TokenPacerClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
    }),
};

export class TokenPacer {
  private readonly windows = new Map<string, Entry[]>();
  /** Reported prompt tokens over our estimate per key: the estimate undercounts some scripts. */
  private readonly ratios = new Map<string, number>();

  constructor(private readonly clock: TokenPacerClock = realClock) {}

  /**
   * Waits until `estimatedTokens` fits in the key's window, then reserves them. A request larger
   * than the whole limit waits for an empty window and goes alone. Returns once reserved, or when
   * `signal` aborts (the caller then sees the abort itself).
   */
  async acquire(
    key: string,
    estimatedTokens: number,
    tokensPerMinute: number,
    signal?: AbortSignal,
  ): Promise<{ slot: PacerSlot; waitedMs: number }> {
    const raw = Math.max(0, Math.ceil(estimatedTokens));
    const tokens = Math.ceil(raw * (this.ratios.get(key) ?? 1));
    const startedAt = this.clock.now();
    for (;;) {
      const now = this.clock.now();
      const entries = (this.windows.get(key) ?? []).filter((entry) => now - entry.at < WINDOW_MS);
      this.windows.set(key, entries);
      const used = entries.reduce((sum, entry) => sum + entry.tokens, 0);
      const wait = signal?.aborted ? 0 : this.waitMs(entries, used, tokens, tokensPerMinute, now);
      if (wait <= 0) {
        const entry: Entry = { at: now, tokens };
        entries.push(entry);
        return {
          waitedMs: now - startedAt,
          slot: {
            settle: (actual) => {
              if (raw > 0 && actual > 0) {
                const previous = this.ratios.get(key) ?? 1;
                const next = actual / raw;
                this.ratios.set(key, Math.min(3, Math.max(0.5, previous * 0.5 + next * 0.5)));
              }
              // A server that omits usage reports 0: keep the estimate.
              if (actual > 0) entry.tokens = actual;
            },
            release: () => {
              const list = this.windows.get(key);
              const index = list?.indexOf(entry) ?? -1;
              if (list && index >= 0) list.splice(index, 1);
            },
          },
        };
      }
      await this.clock.sleep(wait, signal);
    }
  }

  private waitMs(
    entries: Entry[],
    used: number,
    tokens: number,
    limit: number,
    now: number,
  ): number {
    if (entries.length === 0 || used + tokens <= limit) return 0;
    const mustFree = Math.min(used, used + tokens - limit);
    let freed = 0;
    for (const entry of entries) {
      freed += entry.tokens;
      if (freed >= mustFree) return Math.max(1, entry.at + WINDOW_MS - now + SLACK_MS);
    }
    return Math.max(1, (entries.at(-1)?.at ?? now) + WINDOW_MS - now + SLACK_MS);
  }
}

export const sharedTokenPacer = new TokenPacer();
