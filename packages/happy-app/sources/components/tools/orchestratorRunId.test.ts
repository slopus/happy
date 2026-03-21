import { describe, expect, it } from 'vitest';
import { extractOrchestratorSubmitRunId } from './orchestratorRunId';
import { ToolCall } from '@/sync/typesMessage';

function createTool(overrides: Partial<ToolCall>): ToolCall {
    return {
        name: 'mcp__happy__orchestrator_submit',
        state: 'completed',
        input: {},
        createdAt: 0,
        startedAt: 0,
        completedAt: 0,
        description: null,
        ...overrides,
    };
}

describe('extractOrchestratorSubmitRunId', () => {
    it('returns null for non-orchestrator_submit tools', () => {
        const tool = createTool({ name: 'mcp__happy__orchestrator_pend' });
        expect(extractOrchestratorSubmitRunId(tool)).toBeNull();
    });

    it('extracts runId from plain object result', () => {
        const tool = createTool({ result: { data: { runId: 'run-123' } } });
        expect(extractOrchestratorSubmitRunId(tool)).toBe('run-123');
    });

    it('extracts runId from json text array result', () => {
        const tool = createTool({
            result: [{ type: 'text', text: JSON.stringify({ data: { runId: 'run-456' } }) }],
        });
        expect(extractOrchestratorSubmitRunId(tool)).toBe('run-456');
    });

    it('returns null when runId is missing', () => {
        const tool = createTool({ result: { data: { status: 'running' } } });
        expect(extractOrchestratorSubmitRunId(tool)).toBeNull();
    });
});
