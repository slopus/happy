import { describe, expect, it } from 'vitest';
import { shouldShowOrchestratorSubmitActivityIndicator } from './toolStatusIconRules';

describe('shouldShowOrchestratorSubmitActivityIndicator', () => {
    it('returns true for completed orchestrator_submit when running tasks remain in session', () => {
        expect(shouldShowOrchestratorSubmitActivityIndicator({
            toolName: 'mcp__happy__orchestrator_submit',
            toolState: 'completed',
            hasSessionId: true,
            runningTaskCount: 2,
            noStatus: false,
        })).toBe(true);
    });

    it('returns false when tool is not completed', () => {
        expect(shouldShowOrchestratorSubmitActivityIndicator({
            toolName: 'mcp__happy__orchestrator_submit',
            toolState: 'running',
            hasSessionId: true,
            runningTaskCount: 2,
            noStatus: false,
        })).toBe(false);
    });

    it('returns false when there are no running tasks', () => {
        expect(shouldShowOrchestratorSubmitActivityIndicator({
            toolName: 'mcp__happy__orchestrator_submit',
            toolState: 'completed',
            hasSessionId: true,
            runningTaskCount: 0,
            noStatus: false,
        })).toBe(false);
    });

    it('returns false when tool is not orchestrator_submit', () => {
        expect(shouldShowOrchestratorSubmitActivityIndicator({
            toolName: 'mcp__happy__orchestrator_pend',
            toolState: 'completed',
            hasSessionId: true,
            runningTaskCount: 2,
            noStatus: false,
        })).toBe(false);
    });
});
