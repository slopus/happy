import { describe, it, expect } from 'vitest';
import { parseUsageOutput } from './parseUsage';

const FULL_OUTPUT = `You are currently using your subscription to power your Claude Code usage

Current session: 6% used · resets Jun 19, 2:40am (Asia/Seoul)
Current week (all models): 15% used · resets Jun 24, 12:59pm (Asia/Seoul)
Current week (Sonnet only): 2% used · resets Jun 24, 1pm (Asia/Seoul)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai.`;

const ALL_MODELS_ONLY = `You are currently using your subscription to power your Claude Code usage

Current session: 99% used · resets Jun 19, 2:40am (Asia/Seoul)
Current week (all models): 100% used · resets Jun 24, 12:59pm (Asia/Seoul)

What's contributing to your limits usage?`;

const SESSION_WITHOUT_RESET = `You are currently using your subscription to power your Claude Code usage

Current session: 0% used
Current week (all models): 10% used · resets Jul 5 at 7:59pm (Asia/Seoul)

What's contributing to your limits usage?`;

const API_KEY_MODE = `You are currently using Anthropic API keys to power your Claude Code usage.
Track API spend in the Anthropic console.`;

const UNPARSEABLE = `Some other text without recognizable patterns.`;

describe('parseUsageOutput', () => {
    it('parses 3-window output (session + all models + Sonnet)', () => {
        const result = parseUsageOutput(FULL_OUTPUT);
        expect(result.parseError).toBeUndefined();
        expect(result.window5h).toEqual({
            usedPct: 6,
            remainingPct: 94,
            resetAtRaw: 'Jun 19, 2:40am (Asia/Seoul)',
            resetAt: undefined,
        });
        expect(result.windowWeeklyAllModels).toEqual({
            usedPct: 15,
            remainingPct: 85,
            resetAtRaw: 'Jun 24, 12:59pm (Asia/Seoul)',
            resetAt: undefined,
        });
        expect(result.windowWeeklySonnet).toEqual({
            usedPct: 2,
            remainingPct: 98,
            resetAtRaw: 'Jun 24, 1pm (Asia/Seoul)',
            resetAt: undefined,
        });
    });

    it('parses 2-window output without Sonnet line', () => {
        const result = parseUsageOutput(ALL_MODELS_ONLY);
        expect(result.parseError).toBeUndefined();
        expect(result.window5h?.usedPct).toBe(99);
        expect(result.windowWeeklyAllModels?.usedPct).toBe(100);
        expect(result.windowWeeklyAllModels?.remainingPct).toBe(0);
        expect(result.windowWeeklySonnet).toBeUndefined();
    });

    it('parses current session even when Claude omits the reset timestamp', () => {
        const result = parseUsageOutput(SESSION_WITHOUT_RESET);
        expect(result.parseError).toBeUndefined();
        expect(result.window5h).toEqual({
            usedPct: 0,
            remainingPct: 100,
            resetAtRaw: '',
            resetAt: undefined,
        });
        expect(result.windowWeeklyAllModels?.usedPct).toBe(10);
    });

    it('returns parseError on API-key mode output (no window lines)', () => {
        const result = parseUsageOutput(API_KEY_MODE);
        expect(result.window5h).toBeUndefined();
        expect(result.windowWeeklyAllModels).toBeUndefined();
        expect(result.windowWeeklySonnet).toBeUndefined();
        expect(result.parseError).toMatch(/api key|subscription/i);
    });

    it('returns parseError when no window lines are recognized', () => {
        const result = parseUsageOutput(UNPARSEABLE);
        expect(result.window5h).toBeUndefined();
        expect(result.windowWeeklyAllModels).toBeUndefined();
        expect(result.windowWeeklySonnet).toBeUndefined();
        expect(result.parseError).toBeTruthy();
    });
});
