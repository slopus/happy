import { beforeEach, expect, it, vi } from 'vitest';

const disk = vi.hoisted(() => ({
    values: new Map<string, string>(),
    getString: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
}));
vi.mock('react-native-mmkv', () => ({ MMKV: class {
    getString = disk.getString;
    set = disk.set;
    delete = disk.delete;
} }));

import { loadRigComposerDraft, saveRigComposerDraft } from './persistence';

const draft = { text: 'offline text', draftUpdatedAt: 10, permissionMode: 'auto', modelMode: 'codex:model', effortLevel: 'high', serviceTier: null };
beforeEach(() => {
    disk.values.clear();
    vi.clearAllMocks();
    disk.getString.mockImplementation((key: string) => disk.values.get(key));
    disk.set.mockImplementation((key: string, value: string) => disk.values.set(key, value));
    disk.delete.mockImplementation((key: string) => disk.values.delete(key));
});

it('stores drafts, empty text, and timestamped clears independently per session', () => {
    saveRigComposerDraft('first', draft);
    disk.set.mockClear();
    saveRigComposerDraft('second', { ...draft, text: '' });
    expect(disk.set).toHaveBeenCalledTimes(1);
    expect(disk.getString).not.toHaveBeenCalled();
    expect(loadRigComposerDraft('first')).toEqual(draft);
    expect(loadRigComposerDraft('second')?.text).toBe('');
    saveRigComposerDraft('second', { ...draft, text: null });
    expect(loadRigComposerDraft('second')).toEqual({ ...draft, text: null });
    saveRigComposerDraft('second', null);
    expect(loadRigComposerDraft('second')).toBeNull();
    expect(loadRigComposerDraft('first')).toEqual(draft);
});