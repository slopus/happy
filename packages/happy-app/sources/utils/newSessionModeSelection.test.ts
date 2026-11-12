import { describe, expect, it } from 'vitest';
import { resolveNewSessionModeSelection } from './newSessionModeSelection';

describe('resolveNewSessionModeSelection', () => {
    it('resolves raw draft default sentinels to code defaults', () => {
        expect(resolveNewSessionModeSelection({
            agent: 'claude',
            permissionMode: 'default',
            modelMode: 'default',
            effortLevel: null,
            agentDefaultOverrides: {},
        })).toEqual({
            permissionMode: 'bypassPermissions',
            modelMode: 'opus',
            effortLevel: 'medium',
        });
    });

    it('uses agent default overrides instead of raw draft default sentinels', () => {
        expect(resolveNewSessionModeSelection({
            agent: 'codex',
            permissionMode: 'default',
            modelMode: 'default',
            effortLevel: null,
            agentDefaultOverrides: {
                codex: {
                    permissionMode: 'safe-yolo',
                    modelMode: 'gpt-5.4',
                    effortLevel: 'xhigh',
                },
            },
        })).toEqual({
            permissionMode: 'safe-yolo',
            modelMode: 'gpt-5.4',
            effortLevel: 'xhigh',
        });
    });

    it('preserves explicit model and effort picks that match code defaults', () => {
        expect(resolveNewSessionModeSelection({
            agent: 'claude',
            permissionMode: 'bypassPermissions',
            modelMode: 'opus',
            effortLevel: 'medium',
            agentDefaultOverrides: {
                claude: {
                    permissionMode: 'plan',
                    modelMode: 'sonnet',
                    effortLevel: 'xhigh',
                },
            },
        })).toEqual({
            permissionMode: 'plan',
            modelMode: 'opus',
            effortLevel: 'medium',
        });
    });

    it('resolves Codex default permission sentinel to YOLO', () => {
        expect(resolveNewSessionModeSelection({
            agent: 'codex',
            permissionMode: 'default',
            modelMode: 'default',
            effortLevel: null,
            agentDefaultOverrides: {},
        })).toEqual({
            permissionMode: 'yolo',
            modelMode: 'gpt-6.1-sol',
            effortLevel: 'medium',
        });
    });

    it('ignores stale Codex settings overrides that selected CLI defaults', () => {
        expect(resolveNewSessionModeSelection({
            agent: 'codex',
            permissionMode: 'default',
            modelMode: 'default',
            effortLevel: null,
            agentDefaultOverrides: {
                codex: {
                    permissionMode: 'default',
                },
            },
        })).toMatchObject({
            permissionMode: 'yolo',
        });
    });

    it('preserves explicitly selected Codex defaults over different user defaults', () => {
        expect(resolveNewSessionModeSelection({ agent: 'codex', permissionMode: 'default',
            modelMode: 'gpt-6.1-sol', effortLevel: 'medium',
            agentDefaultOverrides: { codex: { modelMode: 'gpt-6-astra', effortLevel: 'high' } },
        })).toMatchObject({ modelMode: 'gpt-6.1-sol', effortLevel: 'medium' });
    });

    it('keeps explicit non-default draft picks', () => {
        expect(resolveNewSessionModeSelection({
            agent: 'codex',
            permissionMode: 'read-only',
            modelMode: 'gpt-5.5',
            effortLevel: 'high',
            agentDefaultOverrides: {
                codex: {
                    permissionMode: 'yolo',
                    modelMode: 'gpt-5.4',
                    effortLevel: 'xhigh',
                },
            },
        })).toEqual({
            permissionMode: 'read-only',
            modelMode: 'gpt-5.5',
            effortLevel: 'high',
        });
    });

    it('chooses a supported effort when medium is unavailable', () => {
        expect(resolveNewSessionModeSelection({ agent: 'codex', permissionMode: 'default',
            modelMode: 'gpt-live', effortLevel: null, agentDefaultOverrides: {},
            modelOptions: [{ key: 'gpt-live', name: 'gpt-live' }],
            effortMetadata: { path: '/repo', host: 'machine', currentModelCode: 'gpt-live',
                thoughtLevels: [{ code: 'high', value: 'high' }, { code: 'max', value: 'max' }] },
        }).effortLevel).toBe('high');
    });

    it('uses dynamic model options when resolving new-session defaults', () => {
        expect(resolveNewSessionModeSelection({
            agent: 'codex',
            permissionMode: 'default',
            modelMode: 'default',
            effortLevel: null,
            agentDefaultOverrides: {
                codex: {
                    modelMode: 'gpt-live',
                    effortLevel: 'xhigh',
                },
            },
            modelOptions: [
                { key: 'default', name: 'default model' },
                { key: 'gpt-live', name: 'gpt-live' },
            ],
            effortMetadata: {
                path: '/repo',
                host: 'machine',
                thoughtLevels: [
                    { code: 'minimal', value: 'minimal' },
                    { code: 'xhigh', value: 'xhigh' },
                ],
            },
        })).toEqual({
            permissionMode: 'yolo',
            modelMode: 'gpt-live',
            effortLevel: 'xhigh',
        });
    });
});
