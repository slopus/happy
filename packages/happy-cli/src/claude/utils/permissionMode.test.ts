import { describe, it, expect } from 'vitest';
import { applySandboxPermissionPolicy, extractPermissionModeFromClaudeArgs, mapToClaudeMode, normalizeRemotePermissionMode, resolveInitialClaudePermissionMode, resolveRemoteClaudePermissionMode } from './permissionMode';
import { MessageMetaSchema, type PermissionMode } from '@/api/types';

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

// The wire schema accepts any string so a newer app can name a mode this CLI
// does not know yet; the unknown value is dropped here rather than the message.
describe('normalizeRemotePermissionMode', () => {
    it('passes through every known mode', () => {
        const allModes: PermissionMode[] = [
            'auto', 'default', 'acceptEdits', 'bypassPermissions', 'plan',
            'read-only', 'safe-yolo', 'yolo',
        ];
        allModes.forEach(mode => {
            expect(normalizeRemotePermissionMode(mode)).toBe(mode);
        });
    });

    it('drops an unknown mode instead of the whole message', () => {
        expect(normalizeRemotePermissionMode('mode-from-the-future')).toBeUndefined();
    });

    it('leaves an absent mode absent', () => {
        expect(normalizeRemotePermissionMode(undefined)).toBeUndefined();
    });
});

describe('MessageMetaSchema permission mode', () => {
    it('accepts a mode this CLI does not know without failing the message', () => {
        const parsed = MessageMetaSchema.safeParse({ permissionMode: 'mode-from-the-future' });
        expect(parsed.success).toBe(true);
    });
});
