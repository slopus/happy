import { describe, it, expect } from 'vitest';
import { applySandboxPermissionPolicy, extractPermissionModeFromClaudeArgs, mapToClaudeMode, resolveInitialClaudePermissionMode } from './permissionMode';
import type { PermissionMode } from '@/api/types';

describe('mapToClaudeMode', () => {
    describe('Codex modes are mapped to Claude equivalents', () => {
        it('maps yolo → bypassPermissions', () => {
            expect(mapToClaudeMode('yolo')).toBe('bypassPermissions');
        });

        it('maps safe-yolo → default', () => {
            expect(mapToClaudeMode('safe-yolo')).toBe('default');
        });

        it('maps read-only → default', () => {
            expect(mapToClaudeMode('read-only')).toBe('default');
        });
    });

    describe('Claude modes pass through unchanged', () => {
        it('passes through default', () => {
            expect(mapToClaudeMode('default')).toBe('default');
        });

        it('passes through acceptEdits', () => {
            expect(mapToClaudeMode('acceptEdits')).toBe('acceptEdits');
        });

        it('passes through bypassPermissions', () => {
            expect(mapToClaudeMode('bypassPermissions')).toBe('bypassPermissions');
        });

        it('passes through plan', () => {
            expect(mapToClaudeMode('plan')).toBe('plan');
        });
    });

    describe('all 7 PermissionMode values are handled', () => {
        const allModes: PermissionMode[] = [
            'default', 'acceptEdits', 'bypassPermissions', 'plan',  // Claude modes
            'read-only', 'safe-yolo', 'yolo'  // Codex modes
        ];

        it('returns a valid Claude mode for every PermissionMode', () => {
            const validClaudeModes = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];

            allModes.forEach(mode => {
                const result = mapToClaudeMode(mode);
                expect(validClaudeModes).toContain(result);
            });
        });
    });
});

describe('extractPermissionModeFromClaudeArgs', () => {
    it('extracts mode from --permission-mode VALUE', () => {
        expect(extractPermissionModeFromClaudeArgs(['--permission-mode', 'bypassPermissions'])).toBe('bypassPermissions');
    });

    it('extracts mode from --permission-mode=VALUE', () => {
        expect(extractPermissionModeFromClaudeArgs(['--foo', '--permission-mode=plan'])).toBe('plan');
    });

    it('returns undefined for invalid mode', () => {
        expect(extractPermissionModeFromClaudeArgs(['--permission-mode', 'invalid'])).toBeUndefined();
    });
});

describe('resolveInitialClaudePermissionMode', () => {
    it('uses --dangerously-skip-permissions as highest priority', () => {
        expect(resolveInitialClaudePermissionMode('default', ['--permission-mode', 'plan', '--dangerously-skip-permissions'])).toBe('bypassPermissions');
    });

    it('uses mode from claude args when present', () => {
        expect(resolveInitialClaudePermissionMode('default', ['--permission-mode', 'acceptEdits'])).toBe('acceptEdits');
    });

    it('falls back to option mode when claude args have no mode', () => {
        expect(resolveInitialClaudePermissionMode('bypassPermissions', ['--foo'])).toBe('bypassPermissions');
    });
});

describe('applySandboxPermissionPolicy', () => {
    it('forces bypassPermissions when sandbox is enabled', () => {
        expect(applySandboxPermissionPolicy('default', true)).toBe('bypassPermissions');
        expect(applySandboxPermissionPolicy(undefined, true)).toBe('bypassPermissions');
    });

    it('forces bypassPermissions for plan mode when sandbox is enabled', () => {
        expect(applySandboxPermissionPolicy('plan', true)).toBe('bypassPermissions');
    });

    it('returns original mode when sandbox is disabled', () => {
        expect(applySandboxPermissionPolicy('acceptEdits', false)).toBe('acceptEdits');
    });
});
