import { describe, expect, it } from 'vitest';
import { resolveMessageModeMeta, UnsupportedPermissionModeError } from './messageMeta';
import { rigMetadataFixture } from './__testdata__/rigMetadata';

describe('resolveMessageModeMeta', () => {
    it('reasserts the displayed codex defaults after abort clears session overrides', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: null,
            modelMode: null,
            effortLevel: null,
            metadata: { flavor: 'codex' },
        } as any);

        expect(meta).toEqual({
            permissionMode: 'yolo',
            model: 'gpt-5.6-sol',
            effort: 'medium',
        });
    });

    // The composer resolves a saved `dontAsk` to Auto because the key is gone
    // from the catalog. Without retiring it at the read path the wire kept
    // sending `dontAsk`, which the CLI's message schema rejects outright.
    it('retires a dontAsk left on an existing session instead of sending it', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: 'dontAsk',
            modelMode: null,
            effortLevel: null,
            metadata: { flavor: 'claude' },
        } as any);

        expect(meta.permissionMode).toBe('acceptEdits');
    });

    it('retires a saved dontAsk default instead of sending it', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: null,
            modelMode: null,
            effortLevel: null,
            metadata: { flavor: 'claude' },
        } as any, {
            agentDefaultOverrides: { claude: { permissionMode: 'dontAsk' } },
        } as any);

        expect(meta.permissionMode).toBe('acceptEdits');
    });

    // A session on an old CLI can still carry `auto` — saved before the gate
    // existed, or applied from a global default — and CLIs before 1.2.1-beta.2
    // reject the whole message envelope on it. The resolver refuses loudly:
    // substituting the code default would silently change permissions (for
    // Claude it would escalate reviewed Auto into yolo).
    it('refuses a saved auto for a claude session on an old CLI', () => {
        expect(() => resolveMessageModeMeta({
            permissionMode: 'auto',
            modelMode: null,
            effortLevel: null,
            metadata: { flavor: 'claude', version: '1.2.1-beta.1' },
        } as any)).toThrow(UnsupportedPermissionModeError);
    });

    it('refuses an auto default override for a codex session on an old CLI', () => {
        expect(() => resolveMessageModeMeta({
            permissionMode: null,
            modelMode: null,
            effortLevel: null,
            metadata: { flavor: 'codex', version: '1.2.0' },
        } as any, {
            agentDefaultOverrides: { codex: { permissionMode: 'auto' } },
        } as any)).toThrow(UnsupportedPermissionModeError);
    });

    it('refuses an auto default override for a claude session on an old CLI', () => {
        expect(() => resolveMessageModeMeta({
            permissionMode: null,
            modelMode: null,
            effortLevel: null,
            metadata: { flavor: 'claude', version: '1.2.0' },
        } as any, {
            agentDefaultOverrides: { claude: { permissionMode: 'auto' } },
        } as any)).toThrow(UnsupportedPermissionModeError);
    });

    it('names the mode and CLI version in the refusal', () => {
        try {
            resolveMessageModeMeta({
                permissionMode: 'auto',
                modelMode: null,
                effortLevel: null,
                metadata: { flavor: 'claude', version: '1.2.0' },
            } as any);
            expect.unreachable('should have thrown');
        } catch (error) {
            expect(error).toBeInstanceOf(UnsupportedPermissionModeError);
            expect((error as Error).message).toContain("'auto'");
            expect((error as Error).message).toContain('1.2.0');
        }
    });

    it('sends auto untouched when the session CLI is new enough', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: 'auto',
            modelMode: null,
            effortLevel: null,
            metadata: { flavor: 'claude', version: '1.2.1-beta.2' },
        } as any);

        expect(meta.permissionMode).toBe('auto');
    });

    it('sends auto when the session reports no CLI version at all', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: 'auto',
            modelMode: null,
            effortLevel: null,
            metadata: { flavor: 'claude' },
        } as any);

        expect(meta.permissionMode).toBe('auto');
    });

    it('sends explicit per-session overrides', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: 'read-only',
            modelMode: 'gpt-5.6-terra',
            effortLevel: 'high',
            metadata: { flavor: 'codex' },
        } as any);

        expect(meta).toEqual({
            permissionMode: 'read-only',
            model: 'gpt-5.6-terra',
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
            modelMode: 'gpt-5.6-terra',
            effortLevel: 'xhigh',
            metadata: { flavor: 'codex' },
        } as any, {
            agentDefaultOverrides: {
                codex: {
                    permissionMode: 'yolo',
                    modelMode: 'gpt-5.6-luna',
                    effortLevel: 'medium',
                },
            },
        } as any);

        expect(meta).toEqual({
            permissionMode: 'default',
            model: 'gpt-5.6-terra',
            effort: 'xhigh',
        });
    });

    it('passes a custom codex model through unchanged', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: null,
            modelMode: 'my-workspace-model',
            effortLevel: null,
            metadata: { flavor: 'codex' },
        } as any);

        expect(meta).toEqual({
            permissionMode: 'yolo',
            model: 'my-workspace-model',
            effort: 'medium',
        });
    });

    it('uses a custom codex model saved in agent settings', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: null,
            modelMode: null,
            effortLevel: null,
            metadata: { flavor: 'codex' },
        } as any, {
            agentDefaultOverrides: {
                codex: { modelMode: 'my-workspace-model' },
            },
        } as any);

        expect(meta).toEqual({
            permissionMode: 'yolo',
            model: 'my-workspace-model',
            effort: 'medium',
        });
    });

    it('fills unset codex fields from settings while preserving session picks', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: 'read-only',
            modelMode: null,
            effortLevel: null,
            metadata: { flavor: 'codex' },
        } as any, {
            agentDefaultOverrides: {
                codex: {
                    permissionMode: 'auto',
                    modelMode: 'gpt-5.6-terra',
                    effortLevel: 'high',
                },
            },
        } as any);

        expect(meta).toEqual({
            permissionMode: 'read-only',
            model: 'gpt-5.6-terra',
            effort: 'high',
        });
    });

    it('treats an explicit claude default model as a reset override', () => {
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
