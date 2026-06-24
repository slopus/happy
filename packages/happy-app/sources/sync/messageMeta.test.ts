import { describe, expect, it } from 'vitest';
import { resolveMessageModeMeta } from './messageMeta';

describe('resolveMessageModeMeta', () => {
    it('sends effective code defaults when nothing was explicitly overridden', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: null,
            modelMode: null,
            effortLevel: null,
            metadata: { flavor: 'codex' },
        } as any);

        expect(meta).toEqual({
            permissionMode: 'yolo',
            model: 'gpt-5.5',
            effort: 'medium',
        });
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

    it('treats an explicit default model as a reset override while still sending other effective defaults', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: null,
            modelMode: 'default',
            effortLevel: null,
            metadata: { flavor: 'claude' },
        } as any);

        expect(meta).toEqual({
            permissionMode: 'bypassPermissions',
            model: null,
            effort: 'medium',
        });
    });
});
