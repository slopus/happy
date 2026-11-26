import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    scope: { key: 'A', serverUrl: 'https://server-a' } as { key: string; serverUrl: string } | null,
    listeners: new Set<() => void>(),
    save: vi.fn(),
}));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({ settings: { agentDefaultOverrides: {} } }) } }));
vi.mock('@/sync/persistence', () => ({ loadNewSessionDraft: () => null, saveNewSessionDraft: vi.fn() }));
vi.mock('@/auth/accountRuntime', () => ({ accountStorageId: (value: string) => value }));
vi.mock('@/sync/firstSubmissionScope', () => ({
    getFirstSubmissionScope: () => state.scope,
    subscribeFirstSubmissionScope: (listener: () => void) => { state.listeners.add(listener); return () => state.listeners.delete(listener); },
}));
vi.mock('@/sync/roleConfigurationHandoff', () => ({
    roleConfigurationCurrent: (record: { scopeKey: string; serverUrl: string }, owner: typeof state.scope) => owner === state.scope && !!owner && record.scopeKey === owner.key && record.serverUrl === owner.serverUrl,
    updateRoleConfiguration: state.save,
}));

import { getRoleConfigurationDraftStores } from './roleConfigurationDrafts';
import { hasComposeDraftAttachments, useComposeDraft } from '@/sync/composeDraft';
import type { RoleConfigurationHandoff } from '@/sync/roleConfigurationHandoff';

function changeScope(key: string) {
    state.scope = { key, serverUrl: 'https://server-a' };
    state.listeners.forEach(listener => listener());
}
function record(revision = 1) {
    return {
        id: 'rc-123', revision, input: 'Configure my role', discussing: false,
        scopeKey: 'A', serverUrl: 'https://server-a',
        config: { selectedMachineId: 'machine-a', agentType: 'codex', modelMode: 'gpt-6-astra', effortLevel: 'ultra' },
    } as RoleConfigurationHandoff;
}
beforeEach(() => {
    changeScope('A');
    state.save.mockClear();
    useComposeDraft.getState().setImages([]);
});

it('keeps a role draft and attachment when its original new-session screen is reopened', () => {
    const first = getRoleConfigurationDraftStores(record(), state.scope!)!;
    const attachment = { id: 'role-file', uri: 'file://role', name: 'requirements.txt' } as any;
    first.compose.getState().setText('Please keep this unfinished change');
    first.compose.getState().setImages([attachment]);
    first.config.getState().setModelMode('gpt-6.1-sol');
    const reopened = getRoleConfigurationDraftStores(record(), state.scope!)!;
    expect(reopened).toBe(first);
    expect(reopened.compose.getState()).toMatchObject({ text: 'Please keep this unfinished change', images: [attachment] });
    expect(reopened.config.getState().modelMode).toBe('gpt-6.1-sol');
    expect(state.save).toHaveBeenCalledWith('rc-123', { input: 'Please keep this unfinished change', discussing: false }, 1);
    expect(useComposeDraft.getState().images).toEqual([]);
    expect(hasComposeDraftAttachments()).toBe(true);
    reopened.compose.getState().setImages([]);
    expect(hasComposeDraftAttachments()).toBe(false);
});

it('replaces obsolete revisions and discards memory-only drafts across account scope changes', () => {
    const originalOwner = state.scope!;
    const first = getRoleConfigurationDraftStores(record(), originalOwner)!;
    first.compose.getState().setImages([{ id: 'old-file' } as any]);
    const revised = getRoleConfigurationDraftStores({ ...record(2), input: 'New request' }, originalOwner)!;
    expect(revised).not.toBe(first);
    expect(revised.compose.getState()).toMatchObject({ text: 'New request', images: [] });
    expect(hasComposeDraftAttachments()).toBe(false);
    revised.compose.getState().setImages([{ id: 'private-a' } as any]);
    changeScope('B');
    expect(hasComposeDraftAttachments()).toBe(false);
    expect(getRoleConfigurationDraftStores(record(2), state.scope!)).toBeNull();
    revised.compose.getState().setText('Late callback');
    expect(state.save).not.toHaveBeenCalled();
    changeScope('A');
    expect(getRoleConfigurationDraftStores(record(2), state.scope!)).not.toBe(revised);
    expect(getRoleConfigurationDraftStores(record(2), originalOwner)).toBeNull();
});

it('preserves attachments when only the settings return origin changes on the same handoff', () => {
    const source: RoleConfigurationHandoff['draft'] = { name:'Writer',description:'Docs',agent:'antigravity',autoDelegate:false };
    const first = getRoleConfigurationDraftStores({ ...record(), draft:source }, state.scope!)!;
    first.compose.getState().setImages([{ id:'requirements',uri:'file://requirements' } as any]);
    const next = getRoleConfigurationDraftStores({ ...record(2), draft:source }, state.scope!)!;
    expect(next.compose.getState().images.map(value=>value.id)).toEqual(['requirements']);
    next.compose.getState().setText('Still working');
    expect(state.save).toHaveBeenLastCalledWith('rc-123',{input:'Still working',discussing:false},2);
});
