import { describe, expect, it } from 'vitest';
import { delegationPermissionMode } from './delegationPermissions';

describe('delegated runtime permission boundaries', () => {
    it('preserves same-runtime restrictions', () => {
        expect(delegationPermissionMode({ agent: 'codex', permissionMode: 'read-only' }, 'codex')).toBe('read-only');
        expect(delegationPermissionMode({ agent: 'antigravity', permissionMode: 'default' }, 'antigravity')).toBe('default');
    });
    it('maps explicitly granted full access in either direction', () => {
        expect(delegationPermissionMode({ agent: 'codex', permissionMode: 'yolo' }, 'antigravity')).toBe('bypassPermissions');
        expect(delegationPermissionMode({ agent: 'antigravity', permissionMode: 'bypassPermissions' }, 'codex')).toBe('yolo');
    });
    it.each(['read-only', 'safe-yolo', 'plan', 'default', 'unexpected'])('does not turn Codex %s into an unrestricted AGY process', permissionMode => {
        expect(() => delegationPermissionMode({ agent: 'codex', permissionMode }, 'antigravity')).toThrow('restricted policy');
    });
    it('does not silently grant Codex write access to an AGY parent that asks permission', () => {
        expect(() => delegationPermissionMode({ agent: 'antigravity', permissionMode: 'default' }, 'codex')).toThrow('restricted policy');
    });
});
