import { describe, expect, it } from 'vitest';
import {
    formatOrchestratorProviderLabel,
    resolveOrchestratorAttemptDisplay,
    resolveOrchestratorSummaryLineData,
    sanitizeOrchestratorOutputSummary,
    sortOrchestratorExecutionsByAttemptDesc,
} from './display';

describe('orchestrator display helpers', () => {
    it('appends model after provider when model exists', () => {
        expect(formatOrchestratorProviderLabel({ provider: 'codex', model: 'gpt-5.3-codex-medium' })).toBe('codex · gpt-5.3-codex-medium');
        expect(formatOrchestratorProviderLabel({ provider: 'claude', model: null })).toBe('claude · default');
    });

    it('keeps attempt denominator at least current executions', () => {
        expect(resolveOrchestratorAttemptDisplay({
            retry: { maxAttempts: 1, backoffMs: 0 },
            executions: [{ executionId: 'e1', attempt: 1 }, { executionId: 'e2', attempt: 2 }] as any,
        })).toEqual({
            current: 2,
            max: 2,
        });
    });

    it('uses max execution attempt when count is lower than attempt number', () => {
        expect(resolveOrchestratorAttemptDisplay({
            retry: { maxAttempts: 1, backoffMs: 0 },
            executions: [{ executionId: 'e2', attempt: 2 }] as any,
        })).toEqual({
            current: 2,
            max: 2,
        });
    });

    it('removes standalone markdown fences from output summary', () => {
        expect(sanitizeOrchestratorOutputSummary('```')).toBeNull();
        expect(sanitizeOrchestratorOutputSummary('```json\nhello\n```')).toBe('hello');
        expect(sanitizeOrchestratorOutputSummary('done')).toBe('done');
    });

    it('sorts execution records by attempt desc', () => {
        const sorted = sortOrchestratorExecutionsByAttemptDesc([
            { executionId: 'e1', attempt: 1 },
            { executionId: 'e3', attempt: 3 },
            { executionId: 'e2', attempt: 2 },
        ] as any);
        expect(sorted.map((item) => item.executionId)).toEqual(['e3', 'e2', 'e1']);
    });

    it('includes queued tasks in running summary line display', () => {
        expect(resolveOrchestratorSummaryLineData({
            total: 3,
            queued: 1,
            running: 1,
            completed: 1,
            failed: 0,
            cancelled: 0,
        })).toEqual({
            total: 3,
            running: 2,
            completed: 1,
            failed: 0,
            cancelled: 0,
        });
    });
});
