import { describe, expect, it } from 'vitest';
import { shouldShowOrchestratorSubmitActivityIndicator } from './toolStatusIconRules';

describe('shouldShowOrchestratorSubmitActivityIndicator', () => {
    it('returns true for completed orchestrator_submit when running tasks remain in session', () => {
        expect(shouldShowOrchestratorSubmitActivityIndicator({
            toolName: 'mcp__happy__orchestrator_submit',
            toolState: 'completed',
            hasSessionId: true,
            noStatus: false,
            isMatchingOrchestratorSubmitRunId: true,
        })).toBe(true);
    });

    it('returns false when tool is not completed', () => {
        expect(shouldShowOrchestratorSubmitActivityIndicator({
            toolName: 'mcp__happy__orchestrator_submit',
            toolState: 'running',
            hasSessionId: true,
            noStatus: false,
            isMatchingOrchestratorSubmitRunId: true,
        })).toBe(false);
    });

    it('returns false when tool is not associated with an active runId', () => {
        expect(shouldShowOrchestratorSubmitActivityIndicator({
            toolName: 'mcp__happy__orchestrator_submit',
            toolState: 'completed',
            hasSessionId: true,
            noStatus: false,
            isMatchingOrchestratorSubmitRunId: false,
        })).toBe(false);
    });

    it('returns false when tool is not orchestrator_submit', () => {
        expect(shouldShowOrchestratorSubmitActivityIndicator({
            toolName: 'mcp__happy__orchestrator_pend',
            toolState: 'completed',
            hasSessionId: true,
            noStatus: false,
            isMatchingOrchestratorSubmitRunId: true,
        })).toBe(false);
    });

    it('returns false when runId does not match running orchestrator submit', () => {
        expect(shouldShowOrchestratorSubmitActivityIndicator({
            toolName: 'mcp__happy__orchestrator_submit',
            toolState: 'completed',
            hasSessionId: true,
            noStatus: false,
            isMatchingOrchestratorSubmitRunId: false,
        })).toBe(false);
    });
});
