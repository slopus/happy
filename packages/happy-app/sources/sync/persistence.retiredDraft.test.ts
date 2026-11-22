import { describe, expect, it, vi } from 'vitest';

const stored = vi.hoisted(() => new Map<string, string | boolean>());
vi.mock('react-native-mmkv', () => ({ MMKV: class {
    getString(key: string) { const value = stored.get(key); return typeof value === 'string' ? value : undefined; }
    getBoolean(key: string) { const value = stored.get(key); return typeof value === 'boolean' ? value : undefined; }
    set(key: string, value: string | boolean) { stored.set(key, value); }
} }));

import { loadNewSessionDraft, saveNewSessionDraft } from './persistence';

describe('retired new-session drafts', () => {
    it('does not restore a Personal draft as another agent and leaves the original bytes in storage', () => {
        const original = JSON.stringify({ input: 'private draft', agentType: 'personal', modelMode: 'saved/model', selectedPath: '/saved' });
        stored.set('new-session-draft-v1', original);
        expect(loadNewSessionDraft()).toBeNull();
        expect(stored.get('new-session-draft-v1')).toBe(original);
    });

    it('ignores malformed selection intent without losing draft content', () => {
        stored.set('new-session-draft-v1', JSON.stringify({ input: 'keep this', agentType: 'codex',
            modelSelection: { agent: 'unknown', defaultValue: 'old' }, effortSelection: { agent: 'codex', defaultValue: 42 } }));
        expect(loadNewSessionDraft()).toMatchObject({ input: 'keep this', agentType: 'codex' });
        expect(loadNewSessionDraft()?.modelSelection).toBeUndefined();
        expect(loadNewSessionDraft()?.effortSelection).toBeUndefined();
    });

    it.each(['codex', 'antigravity'] as const)('round-trips %s drafts with their provider unchanged', (agentType) => {
        const draft = { input: 'coding draft', selectedMachineId: 'machine', selectedPath: '/saved', agentType,
            permissionMode: 'yolo', modelMode: 'gpt-6.1-sol', effortLevel: 'high', fastMode: false,
            modelSelection: { agent: agentType, defaultValue: 'gpt-6-astra' },
            effortSelection: { agent: agentType, defaultValue: 'ultra' },
            sessionType: 'simple' as const, worktreeKey: null, updatedAt: 1 };
        saveNewSessionDraft(draft);
        expect(loadNewSessionDraft()).toEqual(draft);
    });
});
