/**
 * Normalizes plan rate-limit data from the two Claude SDK sources into the
 * backend-neutral UsageLimits shape carried in session agent state:
 *
 * - `rate_limit_event` (push): one window per event — whichever limit
 *   currently binds. `rateLimitType` may be absent, utilization is a 0-1
 *   fraction, `resetsAt` is unix seconds (derived from the
 *   anthropic-ratelimit-unified-reset header).
 * - `get_usage` (pull): all windows at once. Utilization is 0-100,
 *   `resets_at` is an ISO 8601 string, and windows carry no status.
 */
import type { UsageLimits, UsageLimitWindow, UsageLimitWindowStatus } from '@/api/types';

export type UnboundRateLimit = {
    status: UsageLimitWindowStatus,
    utilization?: number | null,
    resetsAt?: number | null,
}

/** A per-turn delta emitted by claudeRemote, merged into agent state by the launcher. */
export type UsageLimitsPatch = {
    capturedAt: number,
    windows: UsageLimitWindow[],
    /** rate_limit_event without a rateLimitType: applies to whichever window currently binds. */
    unbound?: UnboundRateLimit,
    /**
     * Set when the patch contains a full get_usage snapshot: merge starts
     * from the patch instead of the persisted windows, so windows the
     * backend stopped reporting don't linger with a stale status.
     */
    replace?: boolean,
}

export function synthesizeStatus(utilization: number | null | undefined): UsageLimitWindowStatus | undefined {
    if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return undefined;
    if (utilization >= 100) return 'rejected';
    if (utilization >= 90) return 'allowed_warning';
    return 'allowed';
}

// Event utilization is a 0-1 fraction; get_usage is 0-100. The <=1 guard keeps
// this correct if the SDK ever unifies on percent (a true percent <=1 is
// indistinguishable, and misreading ~1% as ~100% is the safe direction).
function normalizeEventUtilization(u: number | undefined): number | undefined {
    if (typeof u !== 'number' || !Number.isFinite(u)) return undefined;
    const percent = u <= 1 ? u * 100 : u;
    return Math.min(100, Math.max(0, Math.round(percent * 10) / 10));
}

// Event resetsAt is unix seconds; agent state carries epoch ms.
function normalizeEventResetsAt(n: number | undefined): number | undefined {
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return undefined;
    return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

function normalizeIsoResetsAt(iso: string | null | undefined): number | null {
    if (!iso) return null;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
}

type GetUsageWindow = { utilization: number | null, resets_at: string | null } | null | undefined;

export function windowsFromGetUsage(rateLimits: Record<string, unknown>): UsageLimitWindow[] {
    const windows: UsageLimitWindow[] = [];
    for (const [id, value] of Object.entries(rateLimits)) {
        // Extra usage is billing/overage state, not a plan rate-limit window.
        if (id === 'extra_usage') continue;
        if (!value || typeof value !== 'object') continue;
        // Only entries with the rate-limit window shape.
        if (!('utilization' in value) && !('resets_at' in value)) continue;
        const w = value as Exclude<GetUsageWindow, null | undefined>;
        const utilization = typeof w.utilization === 'number' && Number.isFinite(w.utilization)
            ? Math.min(100, Math.max(0, w.utilization))
            : null;
        windows.push({
            id,
            utilization,
            resetsAt: normalizeIsoResetsAt(w.resets_at),
            status: synthesizeStatus(utilization),
        });
    }
    return windows;
}

export type RateLimitEventInfo = {
    status: UsageLimitWindowStatus,
    rateLimitType?: string,
    utilization?: number,
    resetsAt?: number,
}

export function fromRateLimitEvent(info: RateLimitEventInfo): { window?: UsageLimitWindow, unbound?: UnboundRateLimit } {
    const utilization = normalizeEventUtilization(info.utilization);
    const resetsAt = normalizeEventResetsAt(info.resetsAt);
    if (info.rateLimitType) {
        return {
            window: {
                id: info.rateLimitType,
                status: info.status,
                utilization: utilization ?? null,
                resetsAt: resetsAt ?? null,
            },
        };
    }
    return { unbound: { status: info.status, utilization: utilization ?? null, resetsAt: resetsAt ?? null } };
}

/**
 * Merges a patch into the current agent-state value. Runs inside the launcher's
 * updateAgentState read-modify-write callback, so `current` is always the
 * latest persisted value — this is what re-hydrates window state across
 * claudeRemote re-entries (mode switches, /clear, stream end).
 */
export function mergeUsageLimits(current: UsageLimits | null | undefined, patch: UsageLimitsPatch): UsageLimits {
    const windows: UsageLimitWindow[] = !patch.replace && Array.isArray(current?.windows) ? [...current.windows] : [];
    for (const incoming of patch.windows) {
        const index = windows.findIndex(w => w.id === incoming.id);
        if (index >= 0) {
            // Allowed rate_limit_events carry no utilization, so a full
            // replace would wipe the percentage seeded by get_usage and the
            // window would render as just a reset time. Keep the last known
            // value; the status and reset time still come from the event.
            windows[index] = {
                ...incoming,
                utilization: incoming.utilization ?? windows[index].utilization,
                resetsAt: incoming.resetsAt ?? windows[index].resetsAt,
            };
        } else {
            windows.push(incoming);
        }
    }
    if (patch.unbound) {
        // No window id on the event: apply to whichever known window is
        // closest to its limit — dropping it would hide the rejected state.
        let target = -1;
        let best = -1;
        for (let i = 0; i < windows.length; i++) {
            const u = windows[i].utilization;
            if (typeof u === 'number' && u > best) {
                best = u;
                target = i;
            }
        }
        if (target < 0) {
            // No window carries a numeric utilization: upsert the synthetic
            // 'plan' window rather than pushing duplicates every turn.
            target = windows.findIndex(w => w.id === 'plan');
        }
        if (target >= 0) {
            windows[target] = {
                ...windows[target],
                status: patch.unbound.status,
                utilization: patch.unbound.utilization ?? windows[target].utilization,
                resetsAt: patch.unbound.resetsAt ?? windows[target].resetsAt,
            };
        } else {
            windows.push({
                id: 'plan',
                status: patch.unbound.status,
                utilization: patch.unbound.utilization ?? null,
                resetsAt: patch.unbound.resetsAt ?? null,
            });
        }
    }
    return { capturedAt: patch.capturedAt, windows };
}
