/**
 * Pulls agy usage quota on demand and emits a metadata patch.
 *
 * agy exposes no per-turn usage signal, so the numbers have to be fetched from a
 * separate endpoint — but they only move when a turn burns quota, so this is
 * driven by turn boundaries rather than a background timer: one pull when the
 * session opens, one after each turn. A minimum interval keeps a burst of short
 * turns from turning into a burst of token exchanges.
 *
 * Calls are serialized and never awaited by the caller: a quota pull must not
 * delay a turn, and a failure just hides the chip rather than breaking anything.
 */
import { createAgyQuotaClient, type AgyQuotaClient } from './agyQuotaClient';
import { agyQuotaToPatch } from './agyUsageAdapter';
import type { UsageLimitsPatch } from '@/claude/utils/usageLimits';

const DEFAULT_MIN_INTERVAL_MS = 60_000;

export interface AgyUsageCollectorOptions {
  onPatch: (patch: UsageLimitsPatch) => void;
  log?: (msg: string) => void;
  /** Minimum gap between two pulls; requests inside the gap are dropped. */
  minIntervalMs?: number;
  client?: AgyQuotaClient;
  now?: () => number;
}

export interface AgyUsageCollector {
  /** Request a refresh. Fire-and-forget: never throws, never blocks the caller. */
  refresh(): void;
  /** Stop emitting patches (an in-flight pull is discarded, not cancelled). */
  stop(): void;
}

export function createAgyUsageCollector(opts: AgyUsageCollectorOptions): AgyUsageCollector {
  const log = opts.log ?? (() => {});
  const client = opts.client ?? createAgyQuotaClient({ log });
  const minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const now = opts.now ?? Date.now;

  let stopped = false;
  let lastPullAt = Number.NEGATIVE_INFINITY;
  let chain: Promise<void> = Promise.resolve();

  const pull = async () => {
    if (stopped) return;
    // Checked inside the chain, not at request time: two refreshes queued back
    // to back should collapse into one pull, not two.
    if (now() - lastPullAt < minIntervalMs) return;
    lastPullAt = now();
    const response = await client.fetchQuota();
    if (stopped) return;
    opts.onPatch(agyQuotaToPatch(response, now()));
  };

  return {
    refresh() {
      chain = chain.then(pull).catch((e) => {
        log(`agy usage refresh failed (ignored): ${e instanceof Error ? e.message : String(e)}`);
      });
    },
    stop() {
      stopped = true;
    },
  };
}
