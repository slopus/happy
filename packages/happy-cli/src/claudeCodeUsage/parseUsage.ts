/**
 * Pure parser for `claude --print --output-format json "/usage"` text output.
 *
 * The CLI returns three optional lines (subscription users see all three;
 * API-key users see a different message):
 *   Current session: N% used [· resets <when>]
 *   Current week (all models): N% used [· resets <when>]
 *   Current week (Sonnet only): N% used [· resets <when>]
 *
 * spec: specs/20260618-machine-cli-usage-quota/decisions.md (D1)
 */

import type { UsageWindow } from './types';

export interface ParsedUsage {
    window5h?: UsageWindow;
    windowWeeklyAllModels?: UsageWindow;
    windowWeeklySonnet?: UsageWindow;
    parseError?: string;
}

const RE_5H = /Current session:\s+(\d+)%\s+used(?:\s+·\s+resets\s+([^\n]+))?/;
const RE_WEEK_ALL = /Current week \(all models\):\s+(\d+)%\s+used(?:\s+·\s+resets\s+([^\n]+))?/;
const RE_WEEK_SONNET = /Current week \(Sonnet only\):\s+(\d+)%\s+used(?:\s+·\s+resets\s+([^\n]+))?/;
const RE_API_KEY_MODE = /Anthropic API keys|using API keys/i;

function toWindow(match: RegExpMatchArray | null): UsageWindow | undefined {
    if (!match) return undefined;
    const usedPct = Math.max(0, Math.min(100, Number(match[1])));
    const resetAtRaw = match[2]?.trim() ?? '';
    const parsed = Date.parse(resetAtRaw);
    return {
        usedPct,
        remainingPct: 100 - usedPct,
        resetAtRaw,
        resetAt: Number.isFinite(parsed) ? parsed : undefined,
    };
}

export function parseUsageOutput(text: string): ParsedUsage {
    const window5h = toWindow(text.match(RE_5H));
    const windowWeeklyAllModels = toWindow(text.match(RE_WEEK_ALL));
    const windowWeeklySonnet = toWindow(text.match(RE_WEEK_SONNET));

    if (window5h || windowWeeklyAllModels || windowWeeklySonnet) {
        return { window5h, windowWeeklyAllModels, windowWeeklySonnet };
    }

    if (RE_API_KEY_MODE.test(text)) {
        return {
            parseError:
                'Claude Code is in API-key mode — subscription quota not reported.',
        };
    }

    return {
        parseError: 'Could not parse /usage output (unknown format).',
    };
}
