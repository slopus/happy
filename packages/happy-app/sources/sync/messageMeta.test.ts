import { describe, expect, it } from 'vitest';
import { resolveMessageModeMeta } from './messageMeta';

describe('resolveMessageModeMeta', () => {
    it('sends Codex YOLO code-default permission metadata when nothing was explicitly overridden', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: null,
            modelMode: null,
            effortLevel: null,
            metadata: { flavor: 'codex' },
        } as any);

        expect(meta).toEqual({
            permissionMode: 'yolo',
            model: null,
            effort: null,
        });
    });

    it.each(['openai', 'gpt'])('uses Codex permission defaults for legacy %s flavors', (flavor) => {
        const meta = resolveMessageModeMeta({
            permissionMode: null,
            modelMode: null,
            effortLevel: null,
            metadata: { flavor },
        } as any, {
            agentDefaultOverrides: {
                codex: { permissionMode: 'acceptEdits' },
            },
        } as any);

        expect(meta.permissionMode).toBe('acceptEdits');
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
            permissionModeExplicit: true,
            model: 'gpt-5.4',
            effort: 'high',
        });
    });

    it('sends the Codex Fast override only after the user selects a speed tier', () => {
        expect(resolveMessageModeMeta({
            permissionMode: null,
            modelMode: null,
            effortLevel: null,
            fastMode: true,
            metadata: {
                flavor: 'codex',
                currentModelCode: 'gpt-5.6-sol',
                models: [{ code: 'gpt-5.6-sol', value: 'gpt-5.6-sol', serviceTiers: [{ id: 'priority', name: 'Fast' }] }],
            },
        } as any)).toMatchObject({ fast: true });

        expect(resolveMessageModeMeta({
            permissionMode: null,
            modelMode: null,
            effortLevel: null,
            fastMode: false,
            metadata: {
                flavor: 'codex',
                currentModelCode: 'gpt-5.6-sol',
                models: [{ code: 'gpt-5.6-sol', value: 'gpt-5.6-sol', serviceTiers: [{ id: 'priority', name: 'Fast' }] }],
            },
        } as any)).toMatchObject({ fast: false });
    });

    it('does not send a stale Fast override for a model without the priority tier', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: null,
            modelMode: 'gpt-5.5',
            effortLevel: null,
            fastMode: true,
            metadata: {
                flavor: 'codex',
                models: [
                    { code: 'gpt-5.6-sol', value: 'gpt-5.6-sol', serviceTiers: [{ id: 'priority', name: 'Fast' }] },
                    { code: 'gpt-5.5', value: 'gpt-5.5' },
                ],
            },
        } as any);

        expect(meta).not.toHaveProperty('fast');
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

    it('lets Codex settings-level yolo override the code-default mode', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: null,
            modelMode: null,
            effortLevel: null,
            metadata: { flavor: 'codex' },
        } as any, {
            agentDefaultOverrides: {
                codex: {
                    permissionMode: 'yolo',
                },
            },
        } as any);

        expect(meta).toEqual({
            permissionMode: 'yolo',
            model: null,
            effort: null,
        });
    });

    it('ignores stale Codex settings-level CLI default overrides', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: null,
            modelMode: null,
            effortLevel: null,
            metadata: { flavor: 'codex' },
        } as any, {
            agentDefaultOverrides: {
                codex: {
                    permissionMode: 'default',
                },
            },
        } as any);

        expect(meta).toEqual({
            permissionMode: 'yolo',
            model: null,
            effort: null,
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
            permissionModeExplicit: true,
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

        expect(meta).toEqual({ permissionMode: 'bypassPermissions', model: null, effort: 'medium' });
    });

    it('treats an explicit default effort as a reset override', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: null,
            modelMode: null,
            effortLevel: 'default',
            metadata: { flavor: 'codex' },
        } as any);

        expect(meta).toEqual({ permissionMode: 'yolo', model: null, effort: null });
    });

    it('records CLI-reported current values before falling back to settings defaults', () => {
        const meta = resolveMessageModeMeta({
            permissionMode: null,
            modelMode: null,
            effortLevel: null,
            metadata: {
                flavor: 'codex',
                currentModelCode: 'gpt-5.6-sol',
                currentThoughtLevelCode: 'xhigh',
            },
        } as any, {
            agentDefaultOverrides: {
                codex: {
                    modelMode: 'gpt-5.5',
                    effortLevel: 'medium',
                },
            },
        } as any);

        expect(meta).toEqual({
            permissionMode: 'yolo',
            model: 'gpt-5.6-sol',
            effort: 'xhigh',
        });
    });

    it.each([
        { flavor: 'gemini', expected: { permissionMode: 'default', model: 'gemini-2.5-pro' } },
        { flavor: 'opencode', expected: { model: 'sub2api/gpt-5.5' } },
    ])('drops unsupported effort metadata for $flavor even when ACP reports thought levels', ({ flavor, expected }) => {
        const meta = resolveMessageModeMeta({
            permissionMode: null,
            modelMode: null,
            effortLevel: 'xhigh',
            metadata: {
                flavor,
                thoughtLevels: [
                    { code: 'medium', value: 'medium' },
                    { code: 'xhigh', value: 'xhigh' },
                ],
                currentThoughtLevelCode: 'xhigh',
            },
        } as any);

        expect(meta).toEqual(expected);
    });
});
