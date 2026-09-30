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
            { timestamp: '2026-08-30T04:59:00.000Z', type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
            tokenCount('2026-08-30T05:00:00.000Z', usage),
        ]);
        writeJsonl(join(sessionsDir, 'copy.jsonl'), [
            tokenCount('2026-08-30T05:00:00.000Z', usage, undefined, usage, 'gpt-5.6-sol'),
        ]);

        const snapshot = await collectCodexUsageSnapshot({
            codexHome,
            now: new Date('2026-08-30T12:00:00.000Z'),
            timeZone: 'UTC',
        });

        expect(snapshot.today).toMatchObject({ totalTokens: 88, tokenCountEvents: 1, sessions: 1 });
    });
});
