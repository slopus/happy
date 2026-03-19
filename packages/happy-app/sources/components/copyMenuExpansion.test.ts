import { describe, expect, it } from 'vitest';
import { getCopyMenuExpansionState } from './copyMenuExpansion';

describe('getCopyMenuExpansionState', () => {
    it('uses the current truncated targets when deciding whether expand should be shown', () => {
        expect(getCopyMenuExpansionState({
            target: 'message-1',
            truncatedTargets: new Set(['message-1']),
            expandedTargets: new Set<string>(),
        })).toEqual({
            isLong: true,
            toggleAction: 'expand',
        });
    });

    it('returns collapse when the current target is expanded', () => {
        expect(getCopyMenuExpansionState({
            target: 3,
            truncatedTargets: new Set([3]),
            expandedTargets: new Set([3]),
        })).toEqual({
            isLong: true,
            toggleAction: 'collapse',
        });
    });

    it('returns no toggle action when the current target is not truncated', () => {
        expect(getCopyMenuExpansionState({
            target: 'message-2',
            truncatedTargets: new Set<string>(),
            expandedTargets: new Set(['message-2']),
        })).toEqual({
            isLong: false,
            toggleAction: null,
        });
    });
});
