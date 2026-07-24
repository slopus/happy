/**
 * Adapts agy's retrieveUserQuota response into the backend-neutral UsageLimits
 * windows carried in session metadata (the same shape the Claude path produces
 * via windowsFromGetUsage). agy quota is per-model — each bucket is one model's
 * remaining fraction with its own reset — so there is no 5h/7d window concept
 * like Claude. We surface:
 *   - one synthetic `agy` headline window (the binding model, i.e. the lowest
 *     remaining) so SessionStatusBar can render a single chip; and
 *   - one `agy:<modelId>` window per model for the detail popover.
 *
 * Source shape (see the ai-usage SwiftBar plugin, which reads the same API):
 *   { buckets: [ { modelId, remainingFraction: 0..1, resetTime: ISO 8601 } ] }
 */
import type { UsageLimitWindow } from '@/api/types';
import { synthesizeStatus, type UsageLimitsPatch } from '@/claude/utils/usageLimits';

/** A single model's quota bucket from retrieveUserQuota. */
export interface AgyQuotaBucket {
  modelId?: string;
  /** Fraction of quota REMAINING, 0..1. */
  remainingFraction?: number | null;
  /** ISO 8601 timestamp when the bucket refills. */
  resetTime?: string | null;
}

export interface AgyQuotaResponse {
  buckets?: AgyQuotaBucket[];
}

/** Stable chip id for the agy headline window. Must match the app chip whitelist. */
export const AGY_HEADLINE_WINDOW_ID = 'agy';

/**
 * Friendlier labels for known model ids; unknown ids fall back to the raw id.
 * Ported from the working menubar plugin — safe to fall out of date, since an
 * unmapped id just renders as-is in the popover.
 */
const AGY_MODEL_LABELS: Record<string, string> = {
  'claude-opus-4-6-thinking': 'Claude Opus 4.6',
  'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'gemini-3.1-pro-high': 'Gemini 3.1 Pro',
  'gemini-3.5-flash-low': 'Gemini 3.5 Flash',
  'gpt-oss-120b-medium': 'GPT-OSS 120B',
};

function resetToEpochMs(resetTime: string | null | undefined): number | null {
  if (!resetTime) return null;
  const ms = Date.parse(resetTime);
  return Number.isFinite(ms) ? ms : null;
}

/** used% (0-100) from a 0..1 remaining fraction. */
function usedPercent(remainingFraction: number): number {
  return Math.min(100, Math.max(0, Math.round((1 - remainingFraction) * 100)));
}

type LimitedBucket = AgyQuotaBucket & { modelId: string; remainingFraction: number };

/**
 * Map a retrieveUserQuota response into UsageLimits windows. Only buckets that
 * report both a numeric remainingFraction and a resetTime are "limited" and
 * surfaced; unlimited models (no reset) are skipped. Returns [] when nothing is
 * limited, which the poller writes as a replace patch to clear a stale chip.
 */
export function agyQuotaToUsageWindows(response: AgyQuotaResponse | null | undefined): UsageLimitWindow[] {
  const buckets = Array.isArray(response?.buckets) ? response!.buckets : [];
  const limited = buckets.filter(
    (b): b is LimitedBucket =>
      typeof b?.modelId === 'string' &&
      typeof b.remainingFraction === 'number' &&
      Number.isFinite(b.remainingFraction) &&
      Boolean(b.resetTime),
  );
  if (limited.length === 0) return [];

  const perModel: UsageLimitWindow[] = limited.map((b) => {
    const utilization = usedPercent(b.remainingFraction);
    return {
      id: `agy:${b.modelId}`,
      label: AGY_MODEL_LABELS[b.modelId] ?? b.modelId,
      utilization,
      resetsAt: resetToEpochMs(b.resetTime),
      status: synthesizeStatus(utilization),
    };
  });

  // Headline = the binding model (lowest remaining / highest used) so the bar
  // shows the constraint the user hits first. It also appears in the popover as
  // an "overall" row above the per-model breakdown.
  const binding = limited.reduce((a, b) => (b.remainingFraction < a.remainingFraction ? b : a));
  const headlineUtilization = usedPercent(binding.remainingFraction);
  const headline: UsageLimitWindow = {
    id: AGY_HEADLINE_WINDOW_ID,
    label: 'agy',
    utilization: headlineUtilization,
    resetsAt: resetToEpochMs(binding.resetTime),
    status: synthesizeStatus(headlineUtilization),
  };

  return [headline, ...perModel];
}

/** Build a full-snapshot patch (replace) for the poller to merge into metadata. */
export function agyQuotaToPatch(
  response: AgyQuotaResponse | null | undefined,
  capturedAt: number,
): UsageLimitsPatch {
  return {
    capturedAt,
    windows: agyQuotaToUsageWindows(response),
    // Full snapshot: drop models the backend stopped reporting instead of
    // letting them linger with a stale status.
    replace: true,
  };
}
