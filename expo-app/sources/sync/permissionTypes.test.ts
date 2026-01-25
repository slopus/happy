import { describe, expect, it } from 'vitest';
import type { PermissionMode } from './permissionTypes';
import {
    isModelMode,
    isPermissionMode,
    getNextPermissionModeForGroup,
    normalizePermissionModeForGroup,
    normalizeProfileDefaultPermissionMode,
} from './permissionTypes';

describe('normalizePermissionModeForGroup', () => {
    it('clamps non-codexLike permission modes to default for codexLike', () => {
        expect(normalizePermissionModeForGroup('plan', 'codexLike')).toBe('default');
    });

    it('clamps codex-like permission modes to default for claude', () => {
        expect(normalizePermissionModeForGroup('read-only', 'claude')).toBe('default');
    });

    it('preserves codex-like modes for codexLike', () => {
        expect(normalizePermissionModeForGroup('safe-yolo', 'codexLike')).toBe('safe-yolo');
        expect(normalizePermissionModeForGroup('yolo', 'codexLike')).toBe('yolo');
    });

    it('preserves claude modes for claude', () => {
        const modes: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
        for (const mode of modes) {
            expect(normalizePermissionModeForGroup(mode, 'claude')).toBe(mode);
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

describe('getNextPermissionModeForGroup', () => {
    it('cycles through codex-like modes and clamps invalid current modes', () => {
        expect(getNextPermissionModeForGroup('default', 'codexLike')).toBe('read-only');
        expect(getNextPermissionModeForGroup('read-only', 'codexLike')).toBe('safe-yolo');
        expect(getNextPermissionModeForGroup('safe-yolo', 'codexLike')).toBe('yolo');
        expect(getNextPermissionModeForGroup('yolo', 'codexLike')).toBe('default');

        // If a claude-only mode slips in, treat it as default before cycling.
        expect(getNextPermissionModeForGroup('plan', 'codexLike')).toBe('read-only');
    });

    it('cycles through claude modes and clamps invalid current modes', () => {
        expect(getNextPermissionModeForGroup('default', 'claude')).toBe('acceptEdits');
        expect(getNextPermissionModeForGroup('acceptEdits', 'claude')).toBe('plan');
        expect(getNextPermissionModeForGroup('plan', 'claude')).toBe('bypassPermissions');
        expect(getNextPermissionModeForGroup('bypassPermissions', 'claude')).toBe('default');

        // If a codex-like mode slips in, treat it as default before cycling.
        expect(getNextPermissionModeForGroup('read-only', 'claude')).toBe('acceptEdits');
    });
});

describe('normalizeProfileDefaultPermissionMode', () => {
    it('preserves codex-like modes for profile defaultPermissionMode', () => {
        expect(normalizeProfileDefaultPermissionMode('read-only')).toBe('read-only');
        expect(normalizeProfileDefaultPermissionMode('safe-yolo')).toBe('safe-yolo');
        expect(normalizeProfileDefaultPermissionMode('yolo')).toBe('yolo');
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
