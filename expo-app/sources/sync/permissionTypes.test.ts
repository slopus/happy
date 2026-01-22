import { describe, expect, it } from 'vitest';
import type { PermissionMode } from './permissionTypes';
import {
    isModelMode,
    isPermissionMode,
    getNextPermissionModeForAgentFlavor,
    normalizePermissionModeForAgentFlavor,
    normalizeProfileDefaultPermissionMode,
} from './permissionTypes';

describe('normalizePermissionModeForAgentFlavor', () => {
    it('clamps non-codex permission modes to default for codex', () => {
        expect(normalizePermissionModeForAgentFlavor('plan', 'codex')).toBe('default');
    });

    it('clamps codex-like permission modes to default for claude', () => {
        expect(normalizePermissionModeForAgentFlavor('read-only', 'claude')).toBe('default');
    });

    it('preserves codex-like modes for gemini', () => {
        expect(normalizePermissionModeForAgentFlavor('safe-yolo', 'gemini')).toBe('safe-yolo');
        expect(normalizePermissionModeForAgentFlavor('yolo', 'gemini')).toBe('yolo');
    });

    it('preserves claude modes for claude', () => {
        const modes: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
        for (const mode of modes) {
            expect(normalizePermissionModeForAgentFlavor(mode, 'claude')).toBe(mode);
        }
    });
});

describe('isPermissionMode', () => {
    it('returns true for valid permission modes', () => {
        expect(isPermissionMode('default')).toBe(true);
        expect(isPermissionMode('read-only')).toBe(true);
        expect(isPermissionMode('plan')).toBe(true);
    });

    it('returns false for invalid values', () => {
        expect(isPermissionMode('bogus')).toBe(false);
        expect(isPermissionMode(null)).toBe(false);
        expect(isPermissionMode(123)).toBe(false);
    });
});

describe('getNextPermissionModeForAgentFlavor', () => {
    it('cycles through codex-like modes and clamps invalid current modes', () => {
        expect(getNextPermissionModeForAgentFlavor('default', 'codex')).toBe('read-only');
        expect(getNextPermissionModeForAgentFlavor('read-only', 'codex')).toBe('safe-yolo');
        expect(getNextPermissionModeForAgentFlavor('safe-yolo', 'codex')).toBe('yolo');
        expect(getNextPermissionModeForAgentFlavor('yolo', 'codex')).toBe('default');

        // If a claude-only mode slips in, treat it as default before cycling.
        expect(getNextPermissionModeForAgentFlavor('plan', 'codex')).toBe('read-only');
    });

    it('cycles through claude modes and clamps invalid current modes', () => {
        expect(getNextPermissionModeForAgentFlavor('default', 'claude')).toBe('acceptEdits');
        expect(getNextPermissionModeForAgentFlavor('acceptEdits', 'claude')).toBe('plan');
        expect(getNextPermissionModeForAgentFlavor('plan', 'claude')).toBe('bypassPermissions');
        expect(getNextPermissionModeForAgentFlavor('bypassPermissions', 'claude')).toBe('default');

        // If a codex-like mode slips in, treat it as default before cycling.
        expect(getNextPermissionModeForAgentFlavor('read-only', 'claude')).toBe('acceptEdits');
    });
});

describe('normalizeProfileDefaultPermissionMode', () => {
    it('clamps codex-like modes to default for profile defaultPermissionMode', () => {
        expect(normalizeProfileDefaultPermissionMode('read-only')).toBe('default');
        expect(normalizeProfileDefaultPermissionMode('safe-yolo')).toBe('default');
        expect(normalizeProfileDefaultPermissionMode('yolo')).toBe('default');
    });
});

describe('isModelMode', () => {
    it('returns true for valid model modes', () => {
        expect(isModelMode('default')).toBe(true);
        expect(isModelMode('adaptiveUsage')).toBe(true);
        expect(isModelMode('gemini-2.5-pro')).toBe(true);
    });

    it('returns false for invalid values', () => {
        expect(isModelMode('bogus')).toBe(false);
        expect(isModelMode(null)).toBe(false);
    });
});
