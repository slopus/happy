import { describe, expect, it } from 'vitest';
import { mapPermissionModeAcrossAgents } from './permissionMapping';

describe('mapPermissionModeAcrossAgents', () => {
    it('returns the same mode when from and to are the same', () => {
        expect(mapPermissionModeAcrossAgents('plan', 'claude', 'claude')).toBe('plan');
    });

    it('maps Claude plan to Gemini safe-yolo', () => {
        expect(mapPermissionModeAcrossAgents('plan', 'claude', 'gemini')).toBe('safe-yolo');
    });

    it('maps Claude bypassPermissions to Gemini yolo', () => {
        expect(mapPermissionModeAcrossAgents('bypassPermissions', 'claude', 'gemini')).toBe('yolo');
    });

    it('maps Claude acceptEdits to Gemini safe-yolo', () => {
        expect(mapPermissionModeAcrossAgents('acceptEdits', 'claude', 'gemini')).toBe('safe-yolo');
    });

    it('maps Codex yolo to Claude bypassPermissions', () => {
        expect(mapPermissionModeAcrossAgents('yolo', 'codex', 'claude')).toBe('bypassPermissions');
    });

    it('maps Gemini safe-yolo to Claude plan', () => {
        expect(mapPermissionModeAcrossAgents('safe-yolo', 'gemini', 'claude')).toBe('plan');
    });

    it('preserves read-only across agents', () => {
        expect(mapPermissionModeAcrossAgents('read-only', 'claude', 'codex')).toBe('read-only');
        // Claude has no true "read-only" mode; map to the safest available Claude mode.
        expect(mapPermissionModeAcrossAgents('read-only', 'codex', 'claude')).toBe('default');
        expect(mapPermissionModeAcrossAgents('read-only', 'gemini', 'claude')).toBe('default');
    });

    it('keeps Codex/Gemini modes unchanged when switching between them', () => {
        expect(mapPermissionModeAcrossAgents('read-only', 'gemini', 'codex')).toBe('read-only');
        expect(mapPermissionModeAcrossAgents('safe-yolo', 'codex', 'gemini')).toBe('safe-yolo');
    });
});
