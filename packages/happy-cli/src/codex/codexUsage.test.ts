import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { collectCodexUsageSnapshot, mergeRecentCodexUsageSnapshot } from './codexUsage';

function writeJsonl(filePath: string, rows: unknown[]): void {
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, rows.map(row => JSON.stringify(row)).join('\n'), 'utf8');
}

function tokenCount(
    timestamp: string,
    lastTokenUsage: Record<string, number>,
    rateLimits?: unknown,
    totalTokenUsage: Record<string, number> = lastTokenUsage,
    model?: string,
): unknown {
    return {
        timestamp,
        type: 'event_msg',
        payload: {
            type: 'token_count',
            info: {
                last_token_usage: lastTokenUsage,
                total_token_usage: totalTokenUsage,
                ...(model ? { model } : {}),
            },
            rate_limits: rateLimits,
        },
    };
}

function sessionMeta(timestamp: string, id: string, parentId?: string): unknown {
    return {
        timestamp,
        type: 'session_meta',
        payload: {
            id,
            ...(parentId ? { forked_from_id: parentId } : {}),
        },
    };
}

function usageRecord(
    timestamp: string,
    threadId: string,
    responseId: string,
    usage: Record<string, number>,
    cumulative: Record<string, number> = usage,
) {
    return {
        timestamp,
        type: 'token_usage_record',
        payload: {
            thread_id: threadId,
            session_id: `connection-${threadId}`,
            turn_id: 'turn',
            response_id: responseId,
            usage: { cached_input_tokens: 0, reasoning_output_tokens: 0, ...usage },
            turn_token_usage: { cached_input_tokens: 0, reasoning_output_tokens: 0, ...cumulative },
            thread_token_usage: { cached_input_tokens: 0, reasoning_output_tokens: 0, ...cumulative },
        },
    };
}

describe('collectCodexUsageSnapshot', () => {
    const created: string[] = [];

    afterEach(() => {
        for (const dir of created.splice(0)) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('includes historical usage from every supplied account home without counting retained copies twice', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'codex-all-homes-'));
        created.push(codexHome);
        const accountA = join(codexHome, 'account-a');
        const accountB = join(codexHome, 'account-b');
        const header = sessionMeta('2026-07-05T01:00:00.000Z', 'shared-session');
        const first = tokenCount('2026-07-05T02:00:00.000Z', { input_tokens: 100, output_tokens: 10, total_tokens: 110 });
        const second = tokenCount('2026-07-05T03:00:00.000Z', { input_tokens: 200, output_tokens: 20, total_tokens: 220 });
        const path = ['sessions', '2026', '07', '05', 'rollout-shared.jsonl'];
        writeJsonl(join(codexHome, ...path), [header, first]);
        writeJsonl(join(accountA, ...path), [header, first, second]);
        writeJsonl(join(accountB, 'archived_sessions', 'rollout-2026-07-06-other.jsonl'), [
            sessionMeta('2026-07-06T01:00:00.000Z', 'other-session'),
            tokenCount('2026-07-06T02:00:00.000Z', { input_tokens: 300, output_tokens: 30, total_tokens: 330 }),
        ]);
        const options = { codexHome, now: new Date('2026-09-30T12:00:00Z'), timeZone: 'UTC', ripgrepCommands: [] };
        const defaultOnly = await collectCodexUsageSnapshot(options);
        expect(defaultOnly.days.map(day => day.totalTokens)).toEqual([110]);
        const all = await collectCodexUsageSnapshot({ ...options, additionalCodexHomes: [accountA, accountB, accountA] });
        expect(all.days.map(day => ({ date: day.date, tokens: day.totalTokens, sessions: day.sessions }))).toEqual([
            { date: '2026-07-05', tokens: 330, sessions: 1 },
            { date: '2026-07-06', tokens: 330, sessions: 1 },
        ]);
        const todayOnly = await collectCodexUsageSnapshot({ ...options, additionalCodexHomes: [accountA, accountB], maxDays: 1 });
        expect(todayOnly.days).toEqual([]);
    });

    it('resolves an old parent across homes during a one-day scan and counts only new account usage', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'codex-cross-home-parent-'));
        created.push(codexHome);
        const account = join(codexHome, 'account');
        const parentPath = join(codexHome, 'sessions/2026/07/05/rollout-parent.jsonl');
        const usage = { input_tokens: 100, output_tokens: 10, total_tokens: 110 };
        writeJsonl(parentPath, [sessionMeta('2026-07-05T01:00:00Z', 'parent'), tokenCount('2026-07-05T02:00:00Z', usage)]);
        utimesSync(parentPath, new Date('2026-07-05'), new Date('2026-07-05'));
        const extra = { input_tokens: 50, output_tokens: 5, total_tokens: 55 };
        const completeParent = join(account, 'sessions/2026/07/05/rollout-parent.jsonl');
        writeJsonl(completeParent, [sessionMeta('2026-07-05T01:00:00Z', 'parent'),
            tokenCount('2026-07-05T02:00:00Z', usage), tokenCount('2026-07-05T03:00:00Z', extra)]);
        utimesSync(completeParent, new Date('2026-07-05'), new Date('2026-07-05'));
        const child = [sessionMeta('2026-09-30T01:00:00Z', 'child', 'parent'),
            tokenCount('2026-09-30T02:00:00Z', usage),
            tokenCount('2026-09-30T02:30:00Z', extra),
            tokenCount('2026-09-30T03:00:00Z', { input_tokens: 200, output_tokens: 20, total_tokens: 220 })];
        writeJsonl(join(account, 'sessions/2026/09/30/rollout-child.jsonl'), child);
        writeJsonl(join(codexHome, 'sessions/2026/09/30/rollout-independent.jsonl'), [
            sessionMeta('2026-09-30T04:00:00Z', 'independent'),
            tokenCount('2026-09-30T05:00:00Z', { input_tokens: 300, output_tokens: 30, total_tokens: 330 }),
        ]);
        const copy = join(codexHome, 'second-account');
        writeJsonl(join(copy, 'sessions/2026/09/30/rollout-child.jsonl'), child);
        const result = await collectCodexUsageSnapshot({ codexHome, additionalCodexHomes: [account, copy],
            now: new Date('2026-09-30T12:00:00Z'), timeZone: 'UTC', maxDays: 1, ripgrepCommands: [] });
        expect(result.days).toHaveLength(1);
        expect(result.today).toMatchObject({ totalTokens: 550, sessions: 2, tokenCountEvents: 2 });
    });

    it('aggregates token_count events by local day', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'codex-usage-home-'));
        created.push(codexHome);

        writeJsonl(join(codexHome, 'sessions', '2026', '07', '05', 'rollout.jsonl'), [
            { timestamp: '2026-07-04T15:59:00.000Z', type: 'event_msg', payload: { type: 'not_token_count' } },
            tokenCount('2026-07-04T16:30:00.000Z', {
                input_tokens: 100,
                cached_input_tokens: 40,
                output_tokens: 20,
                reasoning_output_tokens: 5,
                total_tokens: 120,
            }),
            tokenCount('2026-07-05T08:00:00.000Z', {
                input_tokens: 10,
                cached_input_tokens: 2,
                output_tokens: 3,
                reasoning_output_tokens: 1,
                total_tokens: 13,
            }, {
                plan_type: 'pro',
                primary: { used_percent: 25, window_minutes: 300, resets_at: 1783167726 },
                secondary: { used_percent: 44, window_minutes: 10080, resets_at: 1783414235 },
                rate_limit_reached_type: null,
            }),
        ]);

        const snapshot = await collectCodexUsageSnapshot({
            codexHome,
            now: new Date('2026-07-06T01:00:00.000+08:00'),
            timeZone: 'Asia/Shanghai',
        });

        expect(snapshot.yesterday).toMatchObject({
            date: '2026-07-05',
            inputTokens: 110,
            cachedInputTokens: 42,
            outputTokens: 23,
            reasoningOutputTokens: 6,
            totalTokens: 133,
            tokenCountEvents: 2,
            sessions: 1,
        });
        expect(snapshot.latestEvent?.rateLimits?.primary?.usedPercent).toBe(25);
    });

    it('ignores total-only token_count snapshots that ccusage does not treat as usage', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'codex-usage-home-'));
        created.push(codexHome);

        writeJsonl(join(codexHome, 'sessions', '2026', '07', '05', 'rollout.jsonl'), [
            tokenCount('2026-07-05T05:00:00.000Z', {
                input_tokens: 0,
                cached_input_tokens: 0,
                output_tokens: 0,
                reasoning_output_tokens: 0,
                total_tokens: 398182,
            }),
        ]);

        const snapshot = await collectCodexUsageSnapshot({
            codexHome,
            now: new Date('2026-07-06T01:00:00.000+08:00'),
            timeZone: 'Asia/Shanghai',
        });

        expect(snapshot.yesterday).toBeNull();
        expect(snapshot.latestEvent?.sessionTotalTokenUsage?.totalTokens).toBe(398182);
    });

    it('matches ccusage by aggregating the event total_tokens field', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'codex-usage-home-'));
        created.push(codexHome);

        writeJsonl(join(codexHome, 'sessions', '2026', '07', '05', 'rollout.jsonl'), [
            tokenCount('2026-07-05T05:00:00.000Z', {
                input_tokens: 100,
                cached_input_tokens: 40,
                output_tokens: 20,
                total_tokens: 999,
            }),
        ]);

        const snapshot = await collectCodexUsageSnapshot({
            codexHome,
            now: new Date('2026-07-06T01:00:00.000+08:00'),
            timeZone: 'Asia/Shanghai',
        });

        expect(snapshot.yesterday?.totalTokens).toBe(999);
    });

    it('falls back to streamed JSONL parsing when ripgrep is unavailable', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'codex-usage-home-'));
        created.push(codexHome);

        writeJsonl(join(codexHome, 'sessions', '2026', '07', '05', 'rollout.jsonl'), [
            tokenCount('2026-07-05T05:00:00.000Z', {
                input_tokens: 100,
                cached_input_tokens: 40,
                output_tokens: 20,
                total_tokens: 120,
            }),
        ]);

        const snapshot = await collectCodexUsageSnapshot({
            codexHome,
            now: new Date('2026-07-06T01:00:00.000+08:00'),
            timeZone: 'Asia/Shanghai',
            ripgrepCommands: ['definitely-missing-ripgrep-for-test'],
        });

        expect(snapshot.yesterday?.totalTokens).toBe(120);
    });

    it('separates local dates that cross midnight within one UTC hour', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'codex-usage-home-'));
        created.push(codexHome);

        writeJsonl(join(codexHome, 'sessions', '2026', '08', '30', 'rollout.jsonl'), [
            tokenCount('2026-08-30T18:20:00.000Z', {
                input_tokens: 100,
                cached_input_tokens: 40,
                output_tokens: 20,
                total_tokens: 120,
            }),
            tokenCount('2026-08-30T18:40:00.000Z', {
                input_tokens: 110,
                cached_input_tokens: 42,
                output_tokens: 20,
                total_tokens: 130,
            }),
        ]);

        const snapshot = await collectCodexUsageSnapshot({
            codexHome,
            now: new Date('2026-08-31T12:00:00.000Z'),
            timeZone: 'Asia/Kolkata',
        });

        expect(snapshot.days.find((day) => day.date === '2026-08-30')?.totalTokens).toBe(120);
        expect(snapshot.days.find((day) => day.date === '2026-08-31')?.totalTokens).toBe(130);
    });

    it('keeps the freshest known rate limits when a newer token event omits them', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'codex-usage-home-'));
        created.push(codexHome);

        writeJsonl(join(codexHome, 'sessions', '2026', '07', '05', 'rollout.jsonl'), [
            tokenCount('2026-07-05T05:00:00.000Z', {
                input_tokens: 100,
                cached_input_tokens: 40,
                output_tokens: 20,
                total_tokens: 120,
            }, {
                plan_type: 'pro',
                primary: { used_percent: 25, window_minutes: 300, resets_at: 1783167726 },
            }),
            tokenCount('2026-07-05T05:05:00.000Z', {
                input_tokens: 10,
                cached_input_tokens: 2,
                output_tokens: 3,
                total_tokens: 13,
            }),
        ]);
        writeJsonl(join(codexHome, 'sessions', '2026', '07', '05', 'rollout-newer.jsonl'), [
            tokenCount('2026-07-05T05:10:00.000Z', {
                input_tokens: 8,
                cached_input_tokens: 1,
                output_tokens: 2,
                total_tokens: 10,
            }),
        ]);

        const snapshot = await collectCodexUsageSnapshot({
            codexHome,
            now: new Date('2026-07-06T01:00:00.000+08:00'),
            timeZone: 'Asia/Shanghai',
        });

        expect(snapshot.latestEvent?.timestamp).toBe('2026-07-05T05:10:00.000Z');
        expect(snapshot.latestEvent?.rateLimitsTimestamp).toBe('2026-07-05T05:00:00.000Z');
        expect(snapshot.latestEvent?.rateLimits?.primary?.usedPercent).toBe(25);
    });

    it.each([false, true])('does not replace Codex quota with newer model-specific buckets (stream fallback: %s)', async (streamFallback) => {
        const codexHome = mkdtempSync(join(tmpdir(), 'codex-usage-home-'));
        created.push(codexHome);
        const usage = { input_tokens: 10, output_tokens: 2, total_tokens: 12 };
        writeJsonl(join(codexHome, 'sessions/2026/07/05/account.jsonl'), [
            tokenCount('2026-07-05T05:00:00.000Z', usage, {
                limit_id: 'codex',
                primary: { used_percent: 14, window_minutes: 10080, resets_at: 1783414235 },
            }),
            tokenCount('2026-07-05T05:01:00.000Z', usage, {
                limit_id: 'base_model_inference',
                primary: { used_percent: 0, window_minutes: 10080 },
            }, { input_tokens: 20, output_tokens: 4, total_tokens: 24 }),
        ]);
        writeJsonl(join(codexHome, 'sessions/2026/07/05/spark.jsonl'), [
            tokenCount('2026-07-05T05:02:00.000Z', usage, {
                limit_id: 'codex_bengalfox',
                limit_name: 'GPT-5.3-Codex-Spark',
                primary: { used_percent: 0, window_minutes: 300 },
                secondary: { used_percent: 0, window_minutes: 10080 },
            }),
        ]);
        const snapshot = await collectCodexUsageSnapshot({
            codexHome,
            now: new Date('2026-07-05T06:00:00.000Z'),
            timeZone: 'UTC',
            ...(streamFallback ? { ripgrepCommands: ['definitely-missing-ripgrep-for-test'] } : {}),
        });
        expect(snapshot.latestEvent?.timestamp).toBe('2026-07-05T05:02:00.000Z');
        expect(snapshot.latestEvent?.rateLimitsTimestamp).toBe('2026-07-05T05:00:00.000Z');
        expect(snapshot.latestEvent?.rateLimits?.primary).toEqual({
            usedPercent: 14, windowMinutes: 10080, resetsAt: 1783414235,
        });
        expect(snapshot.latestEvent?.rateLimits?.secondary).toBeUndefined();
        expect(snapshot.today?.totalTokens).toBe(36);
    });

    it('does not report unused Codex quota when only a model-specific bucket is available', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'codex-usage-home-'));
        created.push(codexHome);
        writeJsonl(join(codexHome, 'sessions/2026/07/05/spark.jsonl'), [
            tokenCount('2026-07-05T05:00:00.000Z', { input_tokens: 10, total_tokens: 10 }, {
                limit_id: 'codex_bengalfox', primary: { used_percent: 0, window_minutes: 300 },
            }),
        ]);
        const snapshot = await collectCodexUsageSnapshot({
            codexHome, now: new Date('2026-07-05T06:00:00.000Z'), timeZone: 'UTC',
        });
        expect(snapshot.latestEvent?.rateLimits).toBeUndefined();
        expect(snapshot.latestEvent?.rateLimitsTimestamp).toBeUndefined();
        expect(snapshot.today?.totalTokens).toBe(10);
    });

    it('limits usage to the latest calendar window and includes archived sessions', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'codex-usage-home-'));
        created.push(codexHome);

        writeJsonl(join(codexHome, 'sessions', '2026', '08', '01', 'old.jsonl'), [
            tokenCount('2026-08-01T05:00:00.000Z', {
                input_tokens: 900,
                cached_input_tokens: 800,
                output_tokens: 100,
                reasoning_output_tokens: 20,
                total_tokens: 1000,
            }),
        ]);
        writeJsonl(join(codexHome, 'sessions', '2026', '08', '30', 'active.jsonl'), [
            tokenCount('2026-08-30T05:00:00.000Z', {
                input_tokens: 180,
                cached_input_tokens: 100,
                output_tokens: 20,
                reasoning_output_tokens: 5,
                total_tokens: 200,
            }),
        ]);
        writeJsonl(join(codexHome, 'archived_sessions', 'rollout-2026-08-29T05-00-00.jsonl'), [
            tokenCount('2026-08-29T05:00:00.000Z', {
                input_tokens: 270,
                cached_input_tokens: 200,
                output_tokens: 30,
                reasoning_output_tokens: 10,
                total_tokens: 300,
            }),
        ]);

        const snapshot = await collectCodexUsageSnapshot({
            codexHome,
            now: new Date('2026-08-30T12:00:00.000Z'),
            timeZone: 'UTC',
            maxDays: 14,
        });

        expect(snapshot.days.map(day => day.date)).toEqual(['2026-08-29', '2026-08-30']);
        expect(snapshot.days.map(day => day.totalTokens)).toEqual([300, 200]);
        expect(snapshot.days.map(day => day.sessions)).toEqual([1, 1]);
    });

    it('collects the latest 365 calendar days by default', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'codex-usage-home-'));
        created.push(codexHome);

        writeJsonl(join(codexHome, 'sessions', '2025', '08', '31', 'year-start.jsonl'), [
            tokenCount('2025-08-31T05:00:00.000Z', {
                input_tokens: 90,
                cached_input_tokens: 40,
                output_tokens: 10,
                total_tokens: 100,
            }),
        ]);
        writeJsonl(join(codexHome, 'sessions', '2026', '08', '30', 'today.jsonl'), [
            tokenCount('2026-08-30T05:00:00.000Z', {
                input_tokens: 180,
                cached_input_tokens: 100,
                output_tokens: 20,
                total_tokens: 200,
            }),
        ]);

        const snapshot = await collectCodexUsageSnapshot({
            codexHome,
            now: new Date('2026-08-30T12:00:00.000Z'),
            timeZone: 'UTC',
        });

        expect(snapshot.days.map(day => day.date)).toEqual(['2025-08-31', '2026-08-30']);
        expect(snapshot.days.map(day => day.totalTokens)).toEqual([100, 200]);
    });

    it('merges an immediate one-day refresh without dropping older heatmap activity', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'codex-usage-home-'));
        created.push(codexHome);
        const todayFile = join(codexHome, 'sessions', '2026', '08', '30', 'today.jsonl');

        writeJsonl(join(codexHome, 'sessions', '2026', '08', '01', 'older.jsonl'), [
            tokenCount('2026-08-01T05:00:00.000Z', {
                input_tokens: 90,
                cached_input_tokens: 40,
                output_tokens: 10,
                total_tokens: 100,
            }),
        ]);
        writeJsonl(todayFile, [
            tokenCount('2026-08-30T05:00:00.000Z', {
                input_tokens: 180,
                cached_input_tokens: 100,
                output_tokens: 20,
                total_tokens: 200,
            }, {
                primary: { used_percent: 25, window_minutes: 300 },
            }),
        ]);

        const previous = await collectCodexUsageSnapshot({
            codexHome,
            now: new Date('2026-08-30T12:00:00.000Z'),
            timeZone: 'UTC',
        });

        writeJsonl(todayFile, [
            tokenCount('2026-08-30T05:00:00.000Z', {
                input_tokens: 180,
                cached_input_tokens: 100,
                output_tokens: 20,
                total_tokens: 200,
            }, {
                primary: { used_percent: 25, window_minutes: 300 },
            }),
            tokenCount('2026-08-30T06:00:00.000Z', {
                input_tokens: 45,
                cached_input_tokens: 20,
                output_tokens: 5,
                total_tokens: 50,
            }, {
                primary: { used_percent: 40, window_minutes: 300 },
            }),
        ]);

        const recent = await collectCodexUsageSnapshot({
            codexHome,
            now: new Date('2026-08-30T12:01:00.000Z'),
            timeZone: 'UTC',
            maxDays: 1,
        });
        const merged = mergeRecentCodexUsageSnapshot(previous, recent);

        expect(merged.days.map(day => day.date)).toEqual(['2026-08-01', '2026-08-30']);
        expect(merged.today).toMatchObject({ date: '2026-08-30', totalTokens: 250 });
        expect(merged.latestEvent?.rateLimits?.primary?.usedPercent).toBe(40);
        expect(merged.scannedAt).toBe(recent.scannedAt);
    });

    it('includes in-range events from a session file created before the visible window', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'codex-usage-home-'));
        created.push(codexHome);

        writeJsonl(join(codexHome, 'sessions', '2026', '08', '16', 'long-running.jsonl'), [
            tokenCount('2026-08-17T05:00:00.000Z', {
                input_tokens: 90,
                cached_input_tokens: 40,
                output_tokens: 10,
                total_tokens: 100,
            }),
        ]);

        const snapshot = await collectCodexUsageSnapshot({
            codexHome,
            now: new Date('2026-08-30T12:00:00.000Z'),
            timeZone: 'UTC',
            maxDays: 14,
        });

        expect(snapshot.days).toEqual([
            expect.objectContaining({ date: '2026-08-17', totalTokens: 100 }),
        ]);
    });

    it('skips repeated usage snapshots when the cumulative total did not advance', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'codex-usage-home-'));
        created.push(codexHome);
        const usage = {
            input_tokens: 100,
            cached_input_tokens: 20,
            output_tokens: 10,
            total_tokens: 110,
        };

        writeJsonl(join(codexHome, 'sessions', '2026', '08', '30', 'repeated.jsonl'), [
            tokenCount('2026-08-30T05:00:00.000Z', usage),
            tokenCount('2026-08-30T05:00:01.000Z', usage),
        ]);

        const snapshot = await collectCodexUsageSnapshot({
            codexHome,
            now: new Date('2026-08-30T12:00:00.000Z'),
            timeZone: 'UTC',
        });

        expect(snapshot.today).toMatchObject({ totalTokens: 110, tokenCountEvents: 1 });
    });

    it('excludes replayed parent history from forked sessions', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'codex-usage-home-'));
        created.push(codexHome);
        const sessionsDir = join(codexHome, 'sessions', '2026', '08', '30');
        const parentUsage = {
            input_tokens: 100,
            cached_input_tokens: 20,
            output_tokens: 10,
            total_tokens: 110,
        };
        const childUsage = {
            input_tokens: 50,
            cached_input_tokens: 10,
            output_tokens: 5,
            total_tokens: 55,
        };

        writeJsonl(join(sessionsDir, 'parent.jsonl'), [
            sessionMeta('2026-08-30T04:00:00.000Z', 'parent'),
            tokenCount('2026-08-30T04:01:00.000Z', parentUsage),
        ]);
        writeJsonl(join(sessionsDir, 'child.jsonl'), [
            sessionMeta('2026-08-30T04:02:00.000Z', 'child', 'parent'),
            sessionMeta('2026-08-30T04:02:00.000Z', 'parent'),
            tokenCount('2026-08-30T04:02:00.100Z', parentUsage),
            tokenCount('2026-08-30T04:03:00.000Z', childUsage),
        ]);

        const snapshot = await collectCodexUsageSnapshot({
            codexHome,
            now: new Date('2026-08-30T12:00:00.000Z'),
            timeZone: 'UTC',
        });

        expect(snapshot.today).toMatchObject({
            totalTokens: 165,
            tokenCountEvents: 2,
            sessions: 2,
        });
    });

    it('loads an older parent file to identify a single replayed event', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'codex-usage-home-'));
        created.push(codexHome);
        const parentUsage = {
            input_tokens: 100,
            cached_input_tokens: 20,
            output_tokens: 10,
            total_tokens: 110,
        };
        const childUsage = {
            input_tokens: 50,
            cached_input_tokens: 10,
            output_tokens: 5,
            total_tokens: 55,
        };

        writeJsonl(join(codexHome, 'sessions', '2026', '08', '01', 'parent.jsonl'), [
            sessionMeta('2026-08-01T04:00:00.000Z', 'old-parent'),
            tokenCount('2026-08-01T04:01:00.000Z', parentUsage),
        ]);
        writeJsonl(join(codexHome, 'sessions', '2026', '08', '30', 'child.jsonl'), [
            sessionMeta('2026-08-30T04:02:00.000Z', 'child', 'old-parent'),
            tokenCount('2026-08-30T04:02:00.100Z', parentUsage),
            tokenCount('2026-08-30T04:03:00.000Z', childUsage),
        ]);

        const snapshot = await collectCodexUsageSnapshot({
            codexHome,
            now: new Date('2026-08-30T12:00:00.000Z'),
            timeZone: 'UTC',
            maxDays: 14,
        });

        expect(snapshot.today).toMatchObject({ totalTokens: 55, tokenCountEvents: 1, sessions: 1 });
    });

    it('deduplicates copied usage events across distinct session files', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'codex-usage-home-'));
        created.push(codexHome);
        const sessionsDir = join(codexHome, 'sessions', '2026', '08', '30');
        const usage = {
            input_tokens: 80,
            cached_input_tokens: 10,
            output_tokens: 8,
            total_tokens: 88,
        };

        writeJsonl(join(sessionsDir, 'first.jsonl'), [
            sessionMeta('2026-08-30T04:58:00.000Z', 'copied-session'),
            { timestamp: '2026-08-30T04:59:00.000Z', type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
            tokenCount('2026-08-30T05:00:00.000Z', usage),
        ]);
        writeJsonl(join(sessionsDir, 'copy.jsonl'), [
            sessionMeta('2026-08-30T04:58:00.000Z', 'copied-session'),
            tokenCount('2026-08-30T05:00:00.000Z', usage, undefined, usage, 'gpt-5.6-sol'),
        ]);

        const snapshot = await collectCodexUsageSnapshot({
            codexHome,
            now: new Date('2026-08-30T12:00:00.000Z'),
            timeZone: 'UTC',
        });

        expect(snapshot.today).toMatchObject({ totalTokens: 88, tokenCountEvents: 1, sessions: 1 });
    });

    it.each(['stream', 'ripgrep'] as const)('counts standalone and compaction receipts exactly once (%s)', async (parser) => {
        const codexHome = mkdtempSync(join(tmpdir(), 'codex-native-receipts-'));
        created.push(codexHome);
        const first = { input_tokens: 100, cached_input_tokens: 60, output_tokens: 10, total_tokens: 110 };
        const compactUsage = { input_tokens: 40, cached_input_tokens: 20, output_tokens: 5, total_tokens: 45 };
        const cumulative = { input_tokens: 140, cached_input_tokens: 80, output_tokens: 15, total_tokens: 155 };
        const compact = usageRecord('2026-08-30T05:02:00.000Z', 'thread', 'compact-response', compactUsage, cumulative);
        writeJsonl(join(codexHome, 'sessions/2026/08/30/native.jsonl'), [
            sessionMeta('2026-08-30T04:58:00Z', 'thread'),
            ...(parser === 'ripgrep' ? [{ type: 'padding', text: 'x'.repeat(16 * 1024 * 1024) }] : []),
            usageRecord('2026-08-30T05:01:00.000Z', 'thread', 'first-response', first),
            compact,
            { timestamp: '2026-08-30T05:02:00.010Z', type: 'compacted', payload: {
                compaction_response_id: 'compact-response', latest_token_usage_record: compact.payload,
            } },
        ]);
        const snapshot = await collectCodexUsageSnapshot({ codexHome, now: new Date('2026-08-30T12:00:00Z'),
            timeZone: 'UTC', ripgrepCommands: parser === 'ripgrep' ? ['rg'] : [] });
        expect(snapshot.today).toMatchObject({ inputTokens: 140, cachedInputTokens: 80, outputTokens: 15,
            totalTokens: 155, tokenCountEvents: 2, sessions: 1 });
        expect(snapshot.warnings).toEqual([]);
    });

    it('does not charge retained compaction snapshots as new requests', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'codex-compact-receipt-'));
        created.push(codexHome);
        const compact = usageRecord('2026-08-30T05:02:00Z', 'thread', 'compact-response', {
            input_tokens: 30, output_tokens: 5, total_tokens: 35,
        });
        writeJsonl(join(codexHome, 'sessions/2026/08/30/compact.jsonl'), [
            sessionMeta('2026-08-30T04:00:00Z', 'thread'),
            { timestamp: compact.timestamp, type: 'compacted', payload: {
                compaction_response_id: 'compact-response', latest_token_usage_record: compact.payload,
            } },
            // A retained previous receipt is not evidence of another compact request.
            { timestamp: '2026-08-30T05:03:00Z', type: 'compacted', payload: {
                compaction_response_id: 'different-response', latest_token_usage_record: compact.payload,
            } },
        ]);
        const snapshot = await collectCodexUsageSnapshot({ codexHome, now: new Date('2026-08-30T12:00:00Z'), timeZone: 'UTC' });
        expect(snapshot.today).toBeNull();
    });

    it.each([false, true])('reconciles token_count with response receipts in either order (receipt first: %s)', async (receiptFirst) => {
        const codexHome = mkdtempSync(join(tmpdir(), 'codex-dual-usage-'));
        created.push(codexHome);
        const usage = { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10, total_tokens: 110 };
        const legacy = tokenCount('2026-08-30T05:00:00.010Z', usage);
        const receipt = usageRecord('2026-08-30T05:00:00Z', 'thread', 'response', usage);
        writeJsonl(join(codexHome, 'sessions/2026/08/30/dual.jsonl'), [
            sessionMeta('2026-08-30T04:00:00Z', 'thread'),
            ...(receiptFirst ? [receipt, legacy] : [legacy, receipt]),
            tokenCount('2026-08-30T05:00:01Z', usage),
        ]);
        const snapshot = await collectCodexUsageSnapshot({ codexHome, now: new Date('2026-08-30T12:00:00Z'), timeZone: 'UTC' });
        expect(snapshot.today).toMatchObject({ totalTokens: 110, cachedInputTokens: 80, tokenCountEvents: 1 });
        expect(snapshot.warnings).toEqual([]);
    });

    it('deduplicates receipts across retained copies and preserves distinct response identities', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'codex-copied-receipts-'));
        created.push(codexHome);
        const copy = join(codexHome, 'retained-home');
        const usage = { input_tokens: 100, output_tokens: 10, total_tokens: 110 };
        const rows = [sessionMeta('2026-08-30T04:00:00Z', 'thread'),
            usageRecord('2026-08-30T05:00:00Z', 'thread', 'first-response', usage),
            usageRecord('2026-08-30T05:00:00Z', 'thread', 'second-response', usage),
        ];
        writeJsonl(join(codexHome, 'sessions/2026/08/30/source.jsonl'), rows);
        writeJsonl(join(copy, 'sessions/2026/08/30/copy.jsonl'), rows);
        const snapshot = await collectCodexUsageSnapshot({ codexHome, additionalCodexHomes: [copy],
            now: new Date('2026-08-30T12:00:00Z'), timeZone: 'UTC' });
        expect(snapshot.today).toMatchObject({ totalTokens: 220, tokenCountEvents: 2, sessions: 1 });
    });

    it('replaces revised response usage while retaining the original local day', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'codex-revised-receipt-'));
        created.push(codexHome);
        const initial = { input_tokens: 100, cached_input_tokens: 60, output_tokens: 10, total_tokens: 110 };
        const revised = { input_tokens: 100, cached_input_tokens: 70, output_tokens: 15, total_tokens: 115 };
        writeJsonl(join(codexHome, 'sessions/2026/08/29/revised.jsonl'), [
            sessionMeta('2026-08-29T04:00:00Z', 'thread'),
            tokenCount('2026-08-29T15:59:59.990Z', initial),
            usageRecord('2026-08-29T15:59:59.995Z', 'thread', 'response', initial),
            usageRecord('2026-08-29T16:00:00.010Z', 'thread', 'response', revised),
        ]);
        const snapshot = await collectCodexUsageSnapshot({ codexHome, now: new Date('2026-08-30T04:00:00Z'), timeZone: 'Asia/Shanghai' });
        expect(snapshot.yesterday).toMatchObject({ date: '2026-08-29', totalTokens: 115, cachedInputTokens: 70, tokenCountEvents: 1 });
        expect(snapshot.today).toBeNull();
        expect(snapshot.warnings).toContainEqual(expect.stringContaining('latest receipt replaces earlier amounts on the original receipt date'));
    });

    it('keeps usage from independent sessions even when timestamps and token values coincide', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'codex-distinct-sessions-'));
        created.push(codexHome);
        for (const id of ['first-thread', 'second-thread']) writeJsonl(join(codexHome, `sessions/2026/08/30/${id}.jsonl`), [
            sessionMeta('2026-08-30T04:00:00Z', id),
            tokenCount('2026-08-30T05:00:00Z', { input_tokens: 100, output_tokens: 10, total_tokens: 110 }),
        ]);
        const snapshot = await collectCodexUsageSnapshot({ codexHome, now: new Date('2026-08-30T12:00:00Z'), timeZone: 'UTC' });
        expect(snapshot.today).toMatchObject({ totalTokens: 220, tokenCountEvents: 2, sessions: 2 });
    });

    it.each([false, true])('does not infer replay from fast normal subagent requests (parent found: %s)', async (withParent) => {
        const codexHome = mkdtempSync(join(tmpdir(), 'codex-real-subagent-'));
        created.push(codexHome);
        const first = { input_tokens: 100, output_tokens: 10, total_tokens: 110 };
        const second = { input_tokens: 50, output_tokens: 5, total_tokens: 55 };
        if (withParent) writeJsonl(join(codexHome, 'sessions/2026/08/29/parent.jsonl'), [
            sessionMeta('2026-08-29T04:00:00Z', 'parent'), tokenCount('2026-08-29T05:00:00Z', first),
        ]);
        writeJsonl(join(codexHome, 'sessions/2026/08/30/child.jsonl'), [
            { timestamp: '2026-08-30T04:00:00Z', type: 'session_meta', payload: { id: 'child',
                source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } } } },
            tokenCount('2026-08-30T05:00:00Z', first),
            tokenCount('2026-08-30T05:00:00.500Z', second,
                undefined, { input_tokens: 150, output_tokens: 15, total_tokens: 165 }),
        ]);
        const snapshot = await collectCodexUsageSnapshot({ codexHome, now: new Date('2026-08-30T12:00:00Z'), timeZone: 'UTC' });
        expect(snapshot.today).toMatchObject({ totalTokens: 165, tokenCountEvents: 2, sessions: 1 });
    });

    it('reports a cumulative gap or reset without silently inventing individual requests', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'codex-counter-diagnostics-'));
        created.push(codexHome);
        writeJsonl(join(codexHome, 'sessions/2026/08/30/gap.jsonl'), [
            tokenCount('2026-08-30T05:00:00Z', { input_tokens: 100, total_tokens: 100 }),
            tokenCount('2026-08-30T05:01:00Z', { input_tokens: 50, total_tokens: 50 }, undefined, { input_tokens: 250, total_tokens: 250 }),
            tokenCount('2026-08-30T05:02:00Z', { input_tokens: 20, total_tokens: 20 }),
        ]);
        const snapshot = await collectCodexUsageSnapshot({ codexHome, now: new Date('2026-08-30T12:00:00Z'), timeZone: 'UTC' });
        expect(snapshot.today?.totalTokens).toBe(170);
        expect(snapshot.warnings).toContainEqual(expect.stringContaining('cumulative usage differs'));
        expect(snapshot.warnings).toContainEqual(expect.stringContaining('cumulative counters decreased'));
    });

    it('honors imported receipt boundaries and keeps the next account response', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'codex-imported-receipts-'));
        created.push(codexHome);
        const file = join(codexHome, 'sessions/2026/08/30/imported.jsonl');
        const usage = { input_tokens: 100, output_tokens: 10, total_tokens: 110 };
        const cumulative = { input_tokens: 200, output_tokens: 20, total_tokens: 220 };
        writeJsonl(file, [sessionMeta('2026-08-30T04:00:00Z', 'thread', 'old-parent'),
            usageRecord('2026-08-30T05:00:00Z', 'thread', 'imported-response', usage),
            usageRecord('2026-08-30T05:01:00Z', 'thread', 'new-response', usage, cumulative),
            tokenCount('2026-08-30T05:01:00.010Z', usage, undefined, cumulative),
        ]);
        writeFileSync(`${file}.paws-imported-usage.json`, JSON.stringify({ version: 1, ranges: [[0, 2]] }));
        const snapshot = await collectCodexUsageSnapshot({ codexHome, now: new Date('2026-08-30T12:00:00Z'), timeZone: 'UTC' });
        expect(snapshot.today).toMatchObject({ totalTokens: 110, tokenCountEvents: 1, sessions: 1 });
        expect(snapshot.warnings).toEqual([]);
    });

    it('reconciles legacy counters that omit an independently recorded compaction', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'codex-compact-counter-domain-'));
        created.push(codexHome);
        const first = { input_tokens: 100, output_tokens: 10, total_tokens: 110 };
        const compact = { input_tokens: 40, output_tokens: 5, total_tokens: 45 };
        const next = { input_tokens: 50, output_tokens: 5, total_tokens: 55 };
        writeJsonl(join(codexHome, 'sessions/2026/08/30/domain.jsonl'), [
            sessionMeta('2026-08-30T04:00:00Z', 'thread'),
            usageRecord('2026-08-30T05:00:00Z', 'thread', 'first', first),
            tokenCount('2026-08-30T05:00:00.010Z', first),
            usageRecord('2026-08-30T05:01:00Z', 'thread', 'compact', compact,
                { input_tokens: 140, output_tokens: 15, total_tokens: 155 }),
            usageRecord('2026-08-30T05:02:00Z', 'thread', 'next', next,
                { input_tokens: 190, output_tokens: 20, total_tokens: 210 }),
            tokenCount('2026-08-30T05:02:00.010Z', next, undefined,
                { input_tokens: 150, output_tokens: 15, total_tokens: 165 }),
        ]);
        const snapshot = await collectCodexUsageSnapshot({ codexHome, now: new Date('2026-08-30T12:00:00Z'), timeZone: 'UTC' });
        expect(snapshot.today).toMatchObject({ totalTokens: 210, tokenCountEvents: 3 });
        expect(snapshot.warnings).toEqual([]);
    });

    it.each([false, true])('preserves an independent legacy request of equal size next to a receipt (legacy first: %s)', async (legacyFirst) => {
        const codexHome = mkdtempSync(join(tmpdir(), 'codex-independent-request-'));
        created.push(codexHome);
        const usage = { input_tokens: 100, output_tokens: 10, total_tokens: 110 };
        const twice = { input_tokens: 200, output_tokens: 20, total_tokens: 220 };
        const threeTimes = { input_tokens: 300, output_tokens: 30, total_tokens: 330 };
        const unpairedLegacy = tokenCount('2026-08-30T05:01:00Z', usage, undefined, legacyFirst ? twice : threeTimes);
        const unpairedReceipt = usageRecord('2026-08-30T05:01:00.010Z', 'thread', 'independent-response', usage,
            legacyFirst ? threeTimes : twice);
        writeJsonl(join(codexHome, 'sessions/2026/08/30/equal-requests.jsonl'), [
            sessionMeta('2026-08-30T04:00:00Z', 'thread'),
            usageRecord('2026-08-30T05:00:00Z', 'thread', 'first-response', usage),
            tokenCount('2026-08-30T05:00:00.010Z', usage),
            ...(legacyFirst ? [unpairedLegacy, unpairedReceipt] : [unpairedReceipt, unpairedLegacy]),
        ]);
        const snapshot = await collectCodexUsageSnapshot({ codexHome, now: new Date('2026-08-30T12:00:00Z'), timeZone: 'UTC' });
        expect(snapshot.today).toMatchObject({ totalTokens: 330, tokenCountEvents: 3 });
    });

    it('keeps an identified child response after removing copied parent receipts', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'codex-child-receipt-'));
        created.push(codexHome);
        const usage = { input_tokens: 100, output_tokens: 10, total_tokens: 110 };
        const parent = usageRecord('2026-08-30T05:00:00Z', 'parent', 'parent-response', usage);
        writeJsonl(join(codexHome, 'sessions/2026/08/30/parent.jsonl'), [
            sessionMeta('2026-08-30T04:00:00Z', 'parent'), parent,
        ]);
        writeJsonl(join(codexHome, 'sessions/2026/08/30/child.jsonl'), [
            sessionMeta('2026-08-30T05:01:00Z', 'child', 'parent'), parent,
            usageRecord('2026-08-30T05:02:00Z', 'child', 'child-response', usage),
        ]);
        const snapshot = await collectCodexUsageSnapshot({ codexHome, now: new Date('2026-08-30T12:00:00Z'), timeZone: 'UTC' });
        expect(snapshot.today).toMatchObject({ totalTokens: 220, tokenCountEvents: 2, sessions: 2 });
    });

    it('never overrides a distinct explicit response identity with equal timestamps or amounts', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'codex-distinct-response-'));
        created.push(codexHome);
        const usage = { input_tokens: 100, output_tokens: 10, total_tokens: 110 };
        const legacy = tokenCount('2026-08-30T05:00:00Z', usage, undefined,
            { input_tokens: 200, output_tokens: 20, total_tokens: 220 }) as { payload: Record<string, unknown> };
        legacy.payload.response_id = 'second-response';
        writeJsonl(join(codexHome, 'sessions/2026/08/30/identities.jsonl'), [
            sessionMeta('2026-08-30T04:00:00Z', 'thread'),
            usageRecord('2026-08-30T05:00:00Z', 'thread', 'first-response', usage), legacy,
        ]);
        const snapshot = await collectCodexUsageSnapshot({ codexHome, now: new Date('2026-08-30T12:00:00Z'), timeZone: 'UTC' });
        expect(snapshot.today).toMatchObject({ totalTokens: 220, tokenCountEvents: 2 });
    });

    it('accepts an explicit zero revision but never clears usage from incomplete receipts', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'codex-zero-revision-'));
        created.push(codexHome);
        const positive = { input_tokens: 100, output_tokens: 10, total_tokens: 110 };
        const incomplete = usageRecord('2026-08-30T05:03:00Z', 'thread', 'kept-response', positive);
        const incompleteUsage: Record<string, number> = incomplete.payload.usage;
        delete incompleteUsage.output_tokens;
        writeJsonl(join(codexHome, 'sessions/2026/08/30/revision.jsonl'), [
            sessionMeta('2026-08-30T04:00:00Z', 'thread'),
            usageRecord('2026-08-30T05:00:00Z', 'thread', 'cancelled-response', positive),
            usageRecord('2026-08-30T05:01:00Z', 'thread', 'cancelled-response', { input_tokens: 0, output_tokens: 0, total_tokens: 0 }),
            usageRecord('2026-08-30T05:02:00Z', 'thread', 'kept-response', positive),
            incomplete,
            { timestamp: '2026-08-30T05:04:00Z', type: 'token_usage_record', payload: { thread_id: 'thread', response_id: 'kept-response', usage: {} } },
        ]);
        const snapshot = await collectCodexUsageSnapshot({ codexHome, now: new Date('2026-08-30T12:00:00Z'), timeZone: 'UTC' });
        expect(snapshot.today).toMatchObject({ totalTokens: 110, tokenCountEvents: 1 });
        expect(snapshot.warnings).toContainEqual(expect.stringContaining('receipts revised 1 response'));
        expect(snapshot.warnings).toContainEqual(expect.stringContaining('Incomplete Codex usage receipts ignored for 2 event'));
    });

    it('recognizes reordered JSON keys and whitespace without importing nested history or quoted records', async () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'codex-reordered-native-json-'));
        created.push(codexHome);
        const file = join(codexHome, 'sessions/2026/08/30/reordered.jsonl');
        const receipt = usageRecord('2026-08-30T05:00:00Z', 'thread', 'response', { input_tokens: 100, output_tokens: 10, total_tokens: 110 });
        const reordered = (value: unknown): unknown => Array.isArray(value) ? value.map(reordered)
            : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reordered(item)])) : value;
        const rows = [sessionMeta('2026-08-30T04:00:00Z', 'thread'), receipt,
            tokenCount('2026-08-30T05:00:00.010Z', { input_tokens: 100, output_tokens: 10, total_tokens: 110 }),
            { timestamp: '2026-08-30T05:01:00Z', type: 'compacted', payload: { replacement_history: [receipt], text: 'x'.repeat(16 * 1024 * 1024) } },
            { timestamp: '2026-08-30T05:02:00Z', type: 'event_msg', payload: { type: 'agent_message', message: JSON.stringify(receipt) } },
        ];
        writeJsonl(file, rows.map(reordered));
        const raw = (await import('node:fs/promises')).readFile;
        writeFileSync(file, (await raw(file, 'utf8')).replaceAll('\":', '\": '));
        const snapshot = await collectCodexUsageSnapshot({ codexHome, now: new Date('2026-08-30T12:00:00Z'), timeZone: 'UTC', ripgrepCommands: ['rg'] });
        expect(snapshot.today).toMatchObject({ totalTokens: 110, tokenCountEvents: 1, sessions: 1 });
        expect(snapshot.warnings).toEqual([]);
    });
});
