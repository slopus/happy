import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return store.get(key);
        }

        set(key: string, value: string) {
            store.set(key, value);
        }

        delete(key: string) {
            store.delete(key);
        }

        clearAll() {
            store.clear();
        }
    }

    return { MMKV };
});

import { clearPersistence, loadNewSessionDraft, loadPendingSettings, savePendingSettings, loadSessionModelModes, saveSessionModelModes } from './persistence';

describe('persistence', () => {
    beforeEach(() => {
        clearPersistence();
    });

    describe('session model modes', () => {
        it('returns an empty object when nothing is persisted', () => {
            expect(loadSessionModelModes()).toEqual({});
        });

        it('roundtrips session model modes', () => {
            saveSessionModelModes({ abc: 'gemini-2.5-pro' });
            expect(loadSessionModelModes()).toEqual({ abc: 'gemini-2.5-pro' });
        });

        it('filters out invalid persisted model modes', () => {
            store.set(
                'session-model-modes',
                JSON.stringify({ abc: 'gemini-2.5-pro', bad: 'not-a-model' }),
            );
            expect(loadSessionModelModes()).toEqual({ abc: 'gemini-2.5-pro' });
        });
    });

    describe('pending settings', () => {
        it('returns empty object when nothing is persisted', () => {
            expect(loadPendingSettings()).toEqual({});
        });

        it('does not materialize schema defaults when persisted pending is {}', () => {
            // Historically, parsing pending via SettingsSchema.partial().parse({}) would
            // synthesize defaults (secrets, dismissedCLIWarnings, etc) once defaults were
            // added to the schema. Pending must remain delta-only.
            store.set('pending-settings', JSON.stringify({}));
            expect(loadPendingSettings()).toEqual({});
        });

        it('returns empty object when pending-settings JSON is invalid', () => {
            const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
            store.set('pending-settings', '{ this is not json');
            expect(loadPendingSettings()).toEqual({});
            spy.mockRestore();
        });

        it('returns empty object when persisted pending is not an object', () => {
            store.set('pending-settings', JSON.stringify(null));
            expect(loadPendingSettings()).toEqual({});

            store.set('pending-settings', JSON.stringify('oops'));
            expect(loadPendingSettings()).toEqual({});

            store.set('pending-settings', JSON.stringify(123));
            expect(loadPendingSettings()).toEqual({});

            store.set('pending-settings', JSON.stringify([1, 2, 3]));
            expect(loadPendingSettings()).toEqual({});
        });

        it('drops unknown keys from pending', () => {
            store.set('pending-settings', JSON.stringify({ unknownFutureKey: 1, viewInline: true }));
            expect(loadPendingSettings()).toEqual({ viewInline: true });
        });

        it('drops invalid known keys from pending (type mismatch)', () => {
            store.set('pending-settings', JSON.stringify({ viewInline: 'nope', analyticsOptOut: 123 }));
            expect(loadPendingSettings()).toEqual({});
        });

        it('keeps valid secrets delta and does not inject other defaults', () => {
            store.set('pending-settings', JSON.stringify({
                secrets: [{
                    id: 'k1',
                    name: 'Test',
                    kind: 'apiKey',
                    encryptedValue: { _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'abc' } },
                    createdAt: 1,
                    updatedAt: 1,
                }],
            }));
            const pending = loadPendingSettings() as any;
            expect(Object.keys(pending).sort()).toEqual(['secrets']);
            expect(pending.secrets).toHaveLength(1);
            expect(pending.secrets[0].id).toBe('k1');
        });

        it('drops invalid secrets delta (missing value) and does not inject defaults', () => {
            store.set('pending-settings', JSON.stringify({
                secrets: [{ id: 'k1', name: 'Missing value', encryptedValue: { _isSecretValue: true } }],
            }));
            expect(loadPendingSettings()).toEqual({});
        });

        it('deletes pending-settings key when saving empty object', () => {
            savePendingSettings({ someUnknownKey: 1 } as any);
            expect(store.get('pending-settings')).toBeTruthy();
            savePendingSettings({});
            expect(store.get('pending-settings')).toBeUndefined();
        });
    });

    describe('new session draft', () => {
        it('preserves valid non-session modelMode values', () => {
            store.set(
                'new-session-draft-v1',
                JSON.stringify({
                    input: '',
                    selectedMachineId: null,
                    selectedPath: null,
                    selectedProfileId: null,
                    agentType: 'claude',
                    permissionMode: 'default',
                    modelMode: 'adaptiveUsage',
                    sessionType: 'simple',
                    updatedAt: Date.now(),
                }),
            );

            const draft = loadNewSessionDraft();
            expect(draft?.modelMode).toBe('adaptiveUsage');
        });

        it('roundtrips resumeSessionId when persisted', () => {
            store.set(
                'new-session-draft-v1',
                JSON.stringify({
                    input: '',
                    selectedMachineId: null,
                    selectedPath: null,
                    selectedProfileId: null,
                    agentType: 'claude',
                    permissionMode: 'default',
                    modelMode: 'default',
                    sessionType: 'simple',
                    resumeSessionId: 'abc123',
                    updatedAt: Date.now(),
                }),
            );

            const draft = loadNewSessionDraft();
            expect(draft?.resumeSessionId).toBe('abc123');
        });

        it('migrates legacy auggieAllowIndexing into agentNewSessionOptionStateByAgentId', () => {
            store.set(
                'new-session-draft-v1',
                JSON.stringify({
                    input: '',
                    selectedMachineId: null,
                    selectedPath: null,
                    selectedProfileId: null,
                    agentType: 'auggie',
                    permissionMode: 'default',
                    modelMode: 'default',
                    sessionType: 'simple',
                    auggieAllowIndexing: true,
                    updatedAt: Date.now(),
                }),
            );

            const draft = loadNewSessionDraft();
            expect((draft as any)?.agentNewSessionOptionStateByAgentId?.auggie?.allowIndexing).toBe(true);
        });

        it('clamps invalid permissionMode to default', () => {
            store.set(
                'new-session-draft-v1',
                JSON.stringify({
                    input: '',
                    selectedMachineId: null,
                    selectedPath: null,
                    selectedProfileId: null,
                    agentType: 'gemini',
                    permissionMode: 'bogus',
                    modelMode: 'default',
                    sessionType: 'simple',
                    updatedAt: Date.now(),
                }),
            );

            const draft = loadNewSessionDraft();
            expect(draft?.permissionMode).toBe('default');
        });

        it('clamps invalid modelMode to default', () => {
            store.set(
                'new-session-draft-v1',
                JSON.stringify({
                    input: '',
                    selectedMachineId: null,
                    selectedPath: null,
                    selectedProfileId: null,
                    agentType: 'gemini',
                    permissionMode: 'default',
                    modelMode: 'not-a-real-model',
                    sessionType: 'simple',
                    updatedAt: Date.now(),
                }),
            );

            const draft = loadNewSessionDraft();
            expect(draft?.modelMode).toBe('default');
        });
    });
});
