import { describe, expect, it } from 'vitest';
import type { PermissionMode } from './permissionTypes';
import { normalizePermissionModeForAgentFlavor } from './permissionTypes';

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

