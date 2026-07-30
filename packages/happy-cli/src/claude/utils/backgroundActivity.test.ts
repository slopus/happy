import { describe, expect, it } from 'vitest';
import {
    activityEquals,
    EMPTY_ACTIVITY,
    isActivityEmpty,
    parseBackgroundTasks,
    summarizeBackgroundTasks,
    type BackgroundTaskSummary,
} from './backgroundActivity';

const shell = (status = 'running'): BackgroundTaskSummary => ({
    id: `shell-${status}`,
    type: 'shell',
    status,
    description: 'Build and deploy webapp',
    command: 'pnpm build',
});

describe('parseBackgroundTasks', () => {
    it('keeps well-formed entries', () => {
        const tasks = parseBackgroundTasks([
            { id: 'b1', type: 'shell', status: 'running', description: 'x' },
            { id: 'a1', type: 'subagent', status: 'running', subagent_type: 'general-purpose' },
        ]);
        expect(tasks.map((t) => t.id)).toEqual(['b1', 'a1']);
    });

    it('drops malformed entries instead of throwing', () => {
        // A hook payload shape we do not recognize must never take the session down.
        expect(parseBackgroundTasks([
            { id: 'ok', type: 'shell', status: 'running' },
            { type: 'shell', status: 'running' },
            { id: 'no-type', status: 'running' },
            null,
            'nope',
            42,
        ]).map((t) => t.id)).toEqual(['ok']);
    });

    it('returns empty for a missing or non-array field', () => {
        expect(parseBackgroundTasks(undefined)).toEqual([]);
        expect(parseBackgroundTasks(null)).toEqual([]);
        expect(parseBackgroundTasks({ nope: true })).toEqual([]);
    });
});

describe('summarizeBackgroundTasks', () => {
    it('counts nothing when there are no tasks', () => {
        expect(summarizeBackgroundTasks([])).toEqual(EMPTY_ACTIVITY);
        expect(isActivityEmpty(summarizeBackgroundTasks([]))).toBe(true);
    });

    it('routes each task type into its own bucket', () => {
        const activity = summarizeBackgroundTasks([
            shell(),
            shell(),
            { id: 'a1', type: 'subagent', status: 'running' },
            { id: 'w1', type: 'workflow', status: 'running' },
        ]);
        expect(activity.processes.running).toBe(2);
        expect(activity.subagents).toEqual({ running: 1, queued: 0, total: 1 });
        expect(activity.workflows).toEqual({ running: 1, total: 1 });
        expect(isActivityEmpty(activity)).toBe(false);
    });

    it('separates queued subagents from running ones', () => {
        const activity = summarizeBackgroundTasks([
            { id: 'a1', type: 'subagent', status: 'running' },
            { id: 'a2', type: 'subagent', status: 'pending' },
            { id: 'a3', type: 'subagent', status: 'pending' },
        ]);
        // A fan-out should read as "1 running +2 queued", not "3 running".
        expect(activity.subagents).toEqual({ running: 1, queued: 2, total: 3 });
    });

    it('treats an unknown task type as a generic process rather than dropping it', () => {
        const activity = summarizeBackgroundTasks([
            { id: 'm1', type: 'monitor', status: 'running' },
            { id: 'x1', type: 'some_future_kind', status: 'running' },
        ]);
        expect(activity.processes.running).toBe(2);
        expect(isActivityEmpty(activity)).toBe(false);
    });

    it('matches the task type and status case-insensitively', () => {
        const activity = summarizeBackgroundTasks([
            { id: 'a1', type: 'Subagent', status: 'RUNNING' },
        ]);
        expect(activity.subagents).toEqual({ running: 1, queued: 0, total: 1 });
    });
});

describe('activityEquals', () => {
    it('is true for structurally identical summaries', () => {
        const tasks = [shell(), { id: 'a1', type: 'subagent', status: 'running' }];
        expect(activityEquals(summarizeBackgroundTasks(tasks), summarizeBackgroundTasks(tasks))).toBe(true);
    });

    it('is false once a count moves', () => {
        expect(activityEquals(
            summarizeBackgroundTasks([shell()]),
            summarizeBackgroundTasks([shell(), shell()]),
        )).toBe(false);
    });

    it('distinguishes a running task from a queued one of the same type', () => {
        expect(activityEquals(
            summarizeBackgroundTasks([{ id: 'a1', type: 'subagent', status: 'running' }]),
            summarizeBackgroundTasks([{ id: 'a1', type: 'subagent', status: 'pending' }]),
        )).toBe(false);
    });

    it('treats undefined as equal only to undefined', () => {
        expect(activityEquals(undefined, undefined)).toBe(true);
        expect(activityEquals(EMPTY_ACTIVITY, undefined)).toBe(false);
    });
});
