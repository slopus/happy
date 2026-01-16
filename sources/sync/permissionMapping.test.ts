import { describe, expect, it } from 'vitest';
import { mapPermissionModeAcrossAgents } from './permissionMapping';

describe('mapPermissionModeAcrossAgents', () => {
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

    it('keeps Codex/Gemini modes unchanged when switching between them', () => {
        expect(mapPermissionModeAcrossAgents('read-only', 'gemini', 'codex')).toBe('read-only');
        expect(mapPermissionModeAcrossAgents('safe-yolo', 'codex', 'gemini')).toBe('safe-yolo');
    });
});

