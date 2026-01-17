import { describe, expect, it } from 'vitest';
import type { PermissionMode } from './permissionTypes';
import {
    isModelMode,
    isPermissionMode,
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
