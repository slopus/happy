import { describe, expect, it } from 'vitest';
import { resolveAgentDefaultPin, resolveMessageModeMeta } from './messageMeta';
import { rigMetadataFixture } from './__testdata__/rigMetadata';

describe('resolveMessageModeMeta', () => {
    it('omits agent mode metadata when nothing was explicitly overridden', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: null,
            modelMode: null,
            effortLevel: null,
            metadata: { flavor: 'codex' },
        } as any);

        expect(meta).toEqual({});
    });

    it('sends explicit per-session overrides', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: 'read-only',
            modelMode: 'gpt-5.4',
            effortLevel: 'high',
            metadata: { flavor: 'codex' },
        } as any);

        expect(meta).toEqual({
            permissionMode: 'read-only',
            model: 'gpt-5.4',
            effort: 'high',
        });
    });

    it('sends settings-level overrides when session has no override', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: null,
            modelMode: null,
            effortLevel: null,
            metadata: { flavor: 'claude' },
        } as any, {
            agentDefaultOverrides: {
                claude: {
                    permissionMode: 'bypassPermissions',
                    modelMode: 'opus',
                    effortLevel: 'medium',
                },
            },
        } as any);

        expect(meta).toEqual({
            permissionMode: 'bypassPermissions',
            model: 'opus',
            effort: 'medium',
        });
    });

    it('lets session overrides beat settings-level overrides', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: 'default',
            modelMode: 'gpt-5.4',
            effortLevel: 'xhigh',
            metadata: { flavor: 'codex' },
        } as any, {
            agentDefaultOverrides: {
                codex: {
                    permissionMode: 'yolo',
                    modelMode: 'gpt-5.5',
                    effortLevel: 'medium',
                },
            },
        } as any);

        expect(meta).toEqual({
            permissionMode: 'default',
            model: 'gpt-5.4',
            effort: 'xhigh',
        });
    });

    it('treats an explicit default model as a reset override', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: null,
            modelMode: 'default',
            effortLevel: null,
            metadata: { flavor: 'claude' },
        } as any);

        expect(meta).toEqual({ model: null });
    });

    it('sends canonical Rig selection metadata using mode code rather than semantic kind', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: 'auto',
            modelMode: 'claude:shared-model',
            effortLevel: 'max',
            metadata: rigMetadataFixture,
        } as any);

        expect(meta).toEqual({
            permissionMode: 'auto',
            model: 'shared-model',
            modelProviderId: 'claude',
            effort: 'max',
        });
        expect(meta.permissionMode).not.toBe('safe-yolo');
    });

    it('does not carry an unsupported reasoning value across a Rig model change', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: null,
            modelMode: 'claude:shared-model',
            effortLevel: 'medium',
            metadata: rigMetadataFixture,
        } as any);

        expect(meta.effort).toBe('high');
    });
});

describe('resolveAgentDefaultPin', () => {
    const claudeDefaults = {
        agentDefaultOverrides: {
            claude: {
                permissionMode: 'bypassPermissions',
                modelMode: 'opus',
                effortLevel: 'medium',
            },
        },
    } as any;

    it('pins the settings-level defaults a session falls back to', () => {
        const pin = resolveAgentDefaultPin({
            permissionMode: null,
            modelMode: null,
            effortLevel: null,
            metadata: { flavor: 'claude' },
        } as any, claudeDefaults);

        expect(pin).toEqual({
            permissionMode: 'bypassPermissions',
            modelMode: 'opus',
            effortLevel: 'medium',
        });
    });

    it('leaves a session that already made its own picks alone', () => {
        const pin = resolveAgentDefaultPin({
            permissionMode: 'default',
            modelMode: 'sonnet',
            effortLevel: 'xhigh',
            metadata: { flavor: 'claude' },
        } as any, claudeDefaults);

        expect(pin).toEqual({});
    });

    it('pins only the fields the session is missing', () => {
        const pin = resolveAgentDefaultPin({
            permissionMode: null,
            modelMode: 'sonnet',
            effortLevel: null,
            metadata: { flavor: 'claude' },
        } as any, claudeDefaults);

        expect(pin).toEqual({
            permissionMode: 'bypassPermissions',
            effortLevel: 'medium',
        });
    });

    it('pins nothing when the user set no agent defaults', () => {
        const pin = resolveAgentDefaultPin({
            permissionMode: null,
            modelMode: null,
            effortLevel: null,
            metadata: { flavor: 'claude' },
        } as any, { agentDefaultOverrides: {} } as any);

        expect(pin).toEqual({});
    });

    it('pins nothing for a different agent than the one that was configured', () => {
        const pin = resolveAgentDefaultPin({
            permissionMode: null,
            modelMode: null,
            effortLevel: null,
            metadata: { flavor: 'codex' },
        } as any, claudeDefaults);

        expect(pin).toEqual({});
    });

    it('pins nothing for Rig sessions — the agent carries its own model state', () => {
        const pin = resolveAgentDefaultPin({
            permissionMode: null,
            modelMode: null,
            effortLevel: null,
            metadata: rigMetadataFixture,
        } as any, claudeDefaults);

        expect(pin).toEqual({});
    });
});
