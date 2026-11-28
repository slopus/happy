import { describe, expect, it } from 'vitest';
import { resolveNewSessionModeSelection } from './newSessionModeSelection';

describe('resolveNewSessionModeSelection', () => {
    it('keeps Claude CLI automatic explicit while resolving the permission default', () => {
        expect(resolveNewSessionModeSelection({
            agent: 'claude',
            permissionMode: 'default',
            modelMode: 'default',
            effortLevel: null,
            agentDefaultOverrides: {},
        })).toEqual({
            permissionMode: 'bypassPermissions',
            modelMode: 'default',
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
            modelSelection: { agent: 'codex', defaultValue: 'gpt-6-astra' },
            effortSelection: { agent: 'codex', defaultValue: 'high' },
            agentDefaultOverrides: { codex: { modelMode: 'gpt-6-astra', effortLevel: 'high' } },
        })).toMatchObject({ modelMode: 'gpt-6.1-sol', effortLevel: 'medium' });
    });

    it('keeps explicit non-default draft picks', () => {
        expect(resolveNewSessionModeSelection({
            agent: 'codex',
            permissionMode: 'read-only',
            modelMode: 'gpt-5.5',
            effortLevel: 'high',
            modelSelection: { agent: 'codex', defaultValue: 'gpt-5.4' },
            effortSelection: { agent: 'codex', defaultValue: 'xhigh' },
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

    it('migrates unmarked old Codex values to the current defaults', () => {
        expect(resolveNewSessionModeSelection({ agent: 'codex', permissionMode: 'default',
            modelMode: 'gpt-6.1-sol', effortLevel: 'medium',
            agentDefaultOverrides: { codex: { modelMode: 'gpt-6-astra', effortLevel: 'ultra' } },
        })).toMatchObject({ modelMode: 'gpt-6-astra', effortLevel: 'ultra' });
    });

    it('invalidates old explicit choices when their respective defaults change', () => {
        expect(resolveNewSessionModeSelection({ agent: 'codex', permissionMode: 'default',
            modelMode: 'gpt-5.5', effortLevel: 'low',
            modelSelection: { agent: 'codex', defaultValue: 'gpt-6.1-sol' },
            effortSelection: { agent: 'codex', defaultValue: 'medium' },
            agentDefaultOverrides: { codex: { modelMode: 'gpt-6-astra', effortLevel: 'ultra' } },
        })).toMatchObject({ modelMode: 'gpt-6-astra', effortLevel: 'ultra' });
    });

    it('only invalidates the field whose default changed', () => {
        expect(resolveNewSessionModeSelection({ agent: 'codex', permissionMode: 'default',
            modelMode: 'gpt-5.5', effortLevel: 'low',
            modelSelection: { agent: 'codex', defaultValue: 'gpt-6.1-sol' },
            effortSelection: { agent: 'codex', defaultValue: 'medium' },
            agentDefaultOverrides: { codex: { effortLevel: 'ultra' } },
        })).toMatchObject({ modelMode: 'gpt-5.5', effortLevel: 'ultra' });
    });

    it('preserves explicit native CLI reset instead of resolving App defaults', () => {
        expect(resolveNewSessionModeSelection({ agent: 'codex', permissionMode: 'default',
            modelMode: 'default', effortLevel: 'default',
            modelSelection: { agent: 'codex', defaultValue: 'gpt-6.1-sol' },
            effortSelection: { agent: 'codex', defaultValue: 'medium' },
            agentDefaultOverrides: {},
        })).toMatchObject({ modelMode: 'default', effortLevel: 'default' });
    });

    it('rejects a different engine choice as a Codex override', () => {
        expect(resolveNewSessionModeSelection({ agent: 'codex', permissionMode: 'default',
            modelMode: 'gpt-5.5', effortLevel: 'low',
            modelSelection: { agent: 'claude', defaultValue: 'gpt-6.1-sol' },
            effortSelection: { agent: 'claude', defaultValue: 'medium' },
            agentDefaultOverrides: {},
        })).toMatchObject({ modelMode: 'gpt-6.1-sol', effortLevel: 'medium' });
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


describe('Antigravity explicit selections', () => {
    it('keeps the chosen model and effort before capabilities arrive or when discovery fails', () => {
        expect(resolveNewSessionModeSelection({ agent: 'antigravity', permissionMode: 'default',
            modelMode: 'native-neon', effortLevel: 'xhigh', agentDefaultOverrides: {},
            modelOptions: [{ key: 'default', name: 'default' }], effortMetadata: null,
        })).toMatchObject({ modelMode: 'native-neon', effortLevel: 'xhigh' });
    });
    it('keeps a removed model as the explicit choice so the caller can block send and require reselection', () => {
        expect(resolveNewSessionModeSelection({ agent: 'antigravity', permissionMode: 'default',
            modelMode: 'removed-native', effortLevel: 'high', agentDefaultOverrides: {},
            modelOptions: [{ key: 'current-native', name: 'Current' }],
            effortMetadata: { models: [{ code: 'current-native', value: 'Current' }] } as any,
        }).modelMode).toBe('removed-native');
    });
});


it('uses the advertised Antigravity current model as automatic instead of the first alphabetical model', () => {
    expect(resolveNewSessionModeSelection({agent:'antigravity',permissionMode:'default',modelMode:'default',effortLevel:null,agentDefaultOverrides:{},
        modelOptions:[{key:'argon',name:'Argon'},{key:'neon',name:'Neon'}],effortMetadata:{currentModelCode:'neon'} as any,
    }).modelMode).toBe('neon');
});

it('follows a changed Antigravity effort default without rewriting the retained explicit draft', () => {
    expect(resolveNewSessionModeSelection({agent:'antigravity',permissionMode:'default',modelMode:'neon',effortLevel:'xhigh',
        effortSelection:{agent:'antigravity',defaultValue:'xhigh'},agentDefaultOverrides:{antigravity:{effortLevel:'high'}},
        modelOptions:[{key:'neon',name:'Neon'}],effortMetadata:null,
    }).effortLevel).toBe('high');
});
