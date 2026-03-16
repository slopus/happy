import { describe, expect, it } from 'vitest';
import {
    addTaskCount,
    buildPendCursor,
    createEmptySummaryInternal,
    decodeListCursor,
    deriveRunStatus,
    encodeListCursor,
    isExecutionTerminal,
    isRunTerminal,
    toPublicSummary,
} from './state';

describe('orchestrator state helpers', () => {
    it('maps dispatching into running in public summary', () => {
        const summary = createEmptySummaryInternal();
        addTaskCount(summary, 'queued', 1);
        addTaskCount(summary, 'dispatching', 2);
        addTaskCount(summary, 'running', 3);

        expect(toPublicSummary(summary)).toEqual({
            total: 6,
            queued: 1,
            running: 5,
            completed: 0,
            failed: 0,
            cancelled: 0,
        });
    });

    it('derives run status for canceling run', () => {
        const summary = createEmptySummaryInternal();
        addTaskCount(summary, 'running', 1);
        expect(deriveRunStatus('canceling', summary)).toBe('canceling');

        const terminalSummary = createEmptySummaryInternal();
        addTaskCount(terminalSummary, 'completed', 1);
        addTaskCount(terminalSummary, 'cancelled', 1);
        expect(deriveRunStatus('canceling', terminalSummary)).toBe('cancelled');
    });

    it('treats completed + cancelled as completed when there are no failures', () => {
        const summary = createEmptySummaryInternal();
        addTaskCount(summary, 'completed', 2);
        addTaskCount(summary, 'cancelled', 1);
        expect(deriveRunStatus('running', summary)).toBe('completed');
    });

    it('encodes and decodes list cursor', () => {
        const createdAt = new Date('2026-03-16T01:02:03.000Z');
        const encoded = encodeListCursor(createdAt, 'run_123');
        expect(decodeListCursor(encoded)).toEqual({
            createdAt,
            id: 'run_123',
        });
    });

    it('handles invalid list cursor', () => {
        expect(decodeListCursor('not_base64url')).toBeNull();
    });

    it('detects terminal statuses and creates pend cursor', () => {
        expect(isRunTerminal('completed')).toBe(true);
        expect(isRunTerminal('running')).toBe(false);
        expect(isExecutionTerminal('timeout')).toBe(true);
        expect(isExecutionTerminal('dispatching')).toBe(false);

        const cursor = buildPendCursor({
            runId: 'run_1',
            updatedAt: new Date('2026-03-16T00:00:00.000Z'),
            status: 'running',
            summary: {
                total: 3,
                queued: 1,
                running: 1,
                completed: 1,
                failed: 0,
                cancelled: 0,
            },
        });

        expect(typeof cursor).toBe('string');
        expect(cursor.length).toBeGreaterThan(0);
    });
});
