import { describe, it, expect } from 'vitest';
import { applySandboxPermissionPolicy, extractPermissionModeFromClaudeArgs, mapToClaudeMode, resolveInitialClaudePermissionMode, resolveLocalPermissionModeArgs, resolveRemoteClaudePermissionMode } from './permissionMode';
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

    describe('all 8 PermissionMode values are handled', () => {
        const allModes: PermissionMode[] = [
            'auto', 'default', 'acceptEdits', 'bypassPermissions', 'plan',  // Claude modes
            'read-only', 'safe-yolo', 'yolo'  // Codex modes
        ];

        it('returns a valid Claude mode for every PermissionMode', () => {
            const validClaudeModes = ['auto', 'default', 'acceptEdits', 'bypassPermissions', 'plan'];

            allModes.forEach(mode => {
                const result = mapToClaudeMode(mode);
                expect(validClaudeModes).toContain(result);
            });
        });

        // auto is Claude's own mode, not a Codex one, so it must not be
        // rewritten on the way to the SDK.
        it('passes through auto', () => {
            expect(mapToClaudeMode('auto')).toBe('auto');
        });
    });

    // "Default" in the picker sends no mode at all. Coercing undefined to
    // 'default' here would pin an unset session to prompting mode instead of
    // letting Claude apply its own configuration.
    it('keeps an unset mode unset rather than inventing one', () => {
        expect(mapToClaudeMode(undefined)).toBeUndefined();
    });
});

describe('resolveInitialClaudePermissionMode with no override', () => {
    // Regression: this used to fall back to a hardcoded 'yolo', so choosing
    // Default — the safest-sounding option — started Claude with full access
    // and ignored the user's own configuration.
    it('stays unset when nothing is picked and no args force a mode', () => {
        expect(resolveInitialClaudePermissionMode(undefined, [])).toBeUndefined();
        expect(resolveInitialClaudePermissionMode(undefined, undefined)).toBeUndefined();
    });

    it('still honours an explicit mode and the skip-permissions flag', () => {
        expect(resolveInitialClaudePermissionMode('plan', [])).toBe('plan');
        expect(resolveInitialClaudePermissionMode(undefined, ['--dangerously-skip-permissions']))
            .toBe('bypassPermissions');
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

describe('resolveLocalPermissionModeArgs', () => {
    it('injects --dangerously-skip-permissions for bypass-equivalent modes', () => {
        expect(resolveLocalPermissionModeArgs('yolo', [])).toEqual(['--dangerously-skip-permissions']);
        expect(resolveLocalPermissionModeArgs('bypassPermissions', [])).toEqual(['--dangerously-skip-permissions']);
    });

    it('injects --permission-mode for plan and acceptEdits', () => {
        expect(resolveLocalPermissionModeArgs('plan', [])).toEqual(['--permission-mode', 'plan']);
        expect(resolveLocalPermissionModeArgs('acceptEdits', [])).toEqual(['--permission-mode', 'acceptEdits']);
    });

    it('adds nothing for modes that map to Claude default', () => {
        expect(resolveLocalPermissionModeArgs('default', [])).toEqual([]);
        expect(resolveLocalPermissionModeArgs('safe-yolo', [])).toEqual([]);
        expect(resolveLocalPermissionModeArgs('read-only', [])).toEqual([]);
    });

    it('adds nothing when no mode is resolved', () => {
        expect(resolveLocalPermissionModeArgs(undefined, [])).toEqual([]);
    });

    it('does not override an explicit permission flag already in claudeArgs', () => {
        expect(resolveLocalPermissionModeArgs('yolo', ['--permission-mode', 'plan'])).toEqual([]);
        expect(resolveLocalPermissionModeArgs('yolo', ['--permission-mode=plan'])).toEqual([]);
        expect(resolveLocalPermissionModeArgs('plan', ['--dangerously-skip-permissions'])).toEqual([]);
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
