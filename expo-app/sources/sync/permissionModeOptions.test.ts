import { describe, expect, it } from 'vitest';
import type { PermissionMode } from './permissionTypes';

describe('permissionModeOptions', () => {
    it('normalizes unsupported modes per agent group', async () => {
        const { normalizePermissionModeForAgentType } = await import('./permissionModeOptions');
        expect(normalizePermissionModeForAgentType('read-only', 'claude')).toBe('default');
        expect(normalizePermissionModeForAgentType('acceptEdits', 'codex')).toBe('default');
    });

    it('returns empty badge for default mode', async () => {
        const { getPermissionModeBadgeLabelForAgentType } = await import('./permissionModeOptions');
        expect(getPermissionModeBadgeLabelForAgentType('claude', 'default')).toBe('');
        expect(getPermissionModeBadgeLabelForAgentType('codex', 'default')).toBe('');
    });

    it('returns a non-empty badge label for non-default supported modes', async () => {
        const { getPermissionModeBadgeLabelForAgentType } = await import('./permissionModeOptions');
        expect(getPermissionModeBadgeLabelForAgentType('claude', 'acceptEdits' as PermissionMode)).not.toBe('');
        expect(getPermissionModeBadgeLabelForAgentType('codex', 'read-only' as PermissionMode)).not.toBe('');
        expect(getPermissionModeBadgeLabelForAgentType('gemini', 'safe-yolo' as PermissionMode)).not.toBe('');
    });

    it('returns empty badge label when mode is unsupported for the agent', async () => {
        const { getPermissionModeBadgeLabelForAgentType } = await import('./permissionModeOptions');
        expect(getPermissionModeBadgeLabelForAgentType('codex', 'acceptEdits' as PermissionMode)).toBe('');
    });
});
