import { describe, it, expect } from 'vitest';
import { applySandboxPermissionPolicy, extractPermissionModeFromClaudeArgs, mapToClaudeMode, normalizeLocalClaudePermissionArgs, resolveInitialClaudePermissionMode, resolveRemoteClaudePermissionMode } from './permissionMode';
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

describe('normalizeLocalClaudePermissionArgs', () => {
    it('forwards a resolved Claude mode', () => {
        expect(normalizeLocalClaudePermissionArgs(['--verbose'], 'plan', false)).toEqual([
            '--verbose',
            '--permission-mode',
            'plan',
        ]);
    });

    it('maps yolo and replaces both raw permission-mode forms', () => {
        expect(normalizeLocalClaudePermissionArgs([
            '--permission-mode',
            'plan',
            '--permission-mode=acceptEdits',
            '--verbose',
        ], 'yolo', false)).toEqual([
            '--verbose',
            '--permission-mode',
            'bypassPermissions',
        ]);
    });

    it('does not add a flag for modes that map to default', () => {
        expect(normalizeLocalClaudePermissionArgs(['--verbose'], 'safe-yolo', false)).toEqual(['--verbose']);
    });

    it('does not duplicate an existing dangerous bypass flag', () => {
        expect(normalizeLocalClaudePermissionArgs([
            '--dangerously-skip-permissions',
            '--permission-mode',
            'plan',
        ], 'bypassPermissions', false)).toEqual(['--dangerously-skip-permissions']);
    });

    it('leaves permission enforcement to the sandbox boundary', () => {
        expect(normalizeLocalClaudePermissionArgs([
            '--permission-mode=plan',
            '--verbose',
        ], 'bypassPermissions', true)).toEqual(['--verbose']);
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

describe('resolveRemoteClaudePermissionMode', () => {
    it('preserves bypassPermissions when an app message sends the default mode', () => {
        expect(resolveRemoteClaudePermissionMode('bypassPermissions', 'default', false)).toBe('bypassPermissions');
    });

    it('preserves yolo when an app message sends the default mode', () => {
        expect(resolveRemoteClaudePermissionMode('yolo', 'default', false)).toBe('yolo');
    });

    it('still allows explicit plan mode after bypassPermissions was active', () => {
        expect(resolveRemoteClaudePermissionMode('bypassPermissions', 'plan', false)).toBe('plan');
    });

    it('applies sandbox policy to incoming modes', () => {
        expect(resolveRemoteClaudePermissionMode('default', 'plan', true)).toBe('bypassPermissions');
    });
});
