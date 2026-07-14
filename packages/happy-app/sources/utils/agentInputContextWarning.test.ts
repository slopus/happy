import { describe, expect, it, vi } from 'vitest';
import { resolveAgentInputContextWarning } from './agentInputContextWarning';

vi.mock('@/text', () => ({
    t: (_key: string, params: { percent: number }) => `${params.percent}% remaining`,
}));

const theme = {
    colors: {
        warning: '#warning',
        warningCritical: '#critical',
    },
};

describe('agent input context warning', () => {
    it('shows remaining context when alwaysShow is enabled before usage arrives', () => {
        expect(resolveAgentInputContextWarning(undefined, true, theme)).toEqual({
            text: '100% remaining',
            color: '#warning',
        });
    });

    it('shows remaining context when alwaysShow is enabled and usage is zero', () => {
        expect(resolveAgentInputContextWarning({
            contextSize: 0,
            contextWindow: 190000,
        }, true, theme)).toEqual({
            text: '100% remaining',
            color: '#warning',
        });
    });

    it('still hides healthy context usage when alwaysShow is disabled', () => {
        expect(resolveAgentInputContextWarning({
            contextSize: 1000,
            contextWindow: 190000,
        }, false, theme)).toBeNull();
    });

    it('shows critical context usage regardless of alwaysShow', () => {
        expect(resolveAgentInputContextWarning({
            contextSize: 181000,
            contextWindow: 190000,
        }, false, theme)).toEqual({
            text: '5% remaining',
            color: '#critical',
        });
    });
});
