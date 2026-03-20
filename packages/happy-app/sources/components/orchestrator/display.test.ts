import { describe, expect, it } from 'vitest';
import {
    formatOrchestratorProviderLabel,
    resolveTaskMachineId,
    resolveMachineName,
    resolveOrchestratorAttemptDisplay,
    resolveOrchestratorSummaryLineData,
    sanitizeOrchestratorOutputSummary,
    shortenMachineId,
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

    it('returns latest active execution machine for running tasks', () => {
        expect(resolveTaskMachineId({
            status: 'running',
            executions: [
                { machineId: 'machine-a', status: 'completed' },
                { machineId: 'machine-b', status: 'running' },
            ],
        } as any)).toBe('machine-b');
    });

    it('returns last execution machine for non-active tasks', () => {
        expect(resolveTaskMachineId({
            status: 'completed',
            executions: [
                { machineId: 'machine-a', status: 'running' },
                { machineId: 'machine-b', status: 'completed' },
            ],
        } as any)).toBe('machine-b');
    });

    it('returns null when no execution exists', () => {
        expect(resolveTaskMachineId({ status: 'queued', executions: undefined } as any)).toBeNull();
        expect(resolveTaskMachineId({ status: 'queued', executions: [] } as any)).toBeNull();
    });

    it('shortens machine id to first 8 chars', () => {
        expect(shortenMachineId('123456789abc')).toBe('12345678');
        expect(shortenMachineId('12345678')).toBe('12345678');
        expect(shortenMachineId('abcd')).toBe('abcd');
    });

    it('resolves machine name with shortened id for disambiguation', () => {
        const nameMap = new Map([['id-aaa-bbb', 'My Mac']]);
        expect(resolveMachineName('id-aaa-bbb', nameMap)).toBe('My Mac (id-aaa-b)');
        expect(resolveMachineName('id-aaa-unknown', nameMap)).toBe('id-aaa-u');
    });
});
