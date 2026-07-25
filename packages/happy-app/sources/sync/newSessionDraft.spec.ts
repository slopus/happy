import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native-mmkv', () => ({
    MMKV: class {
        private store = new Map<string, string>();
        getString(key: string) { return this.store.get(key); }
        set(key: string, value: string) { this.store.set(key, value); }
        delete(key: string) { this.store.delete(key); }
    },
}));

import { parseNewSessionDraft } from './persistence';

describe('parseNewSessionDraft', () => {
    it('parses per-agent mode selections', () => {
        const draft = parseNewSessionDraft({
            input: 'hello',
            agentType: 'codex',
            agentModes: {
                claude: { permissionMode: 'bypassPermissions', modelMode: 'claude-opus-5', effortLevel: null },
                codex: { permissionMode: 'yolo', modelMode: 'gpt-5.5', effortLevel: 'high' },
                bogus: { modelMode: 'nope' },
            },
            sessionType: 'simple',
            updatedAt: 42,
        });

        expect(draft).not.toBeNull();
        expect(draft!.agentType).toBe('codex');
        expect(draft!.agentModes).toEqual({
            claude: { permissionMode: 'bypassPermissions', modelMode: 'claude-opus-5', effortLevel: null },
            codex: { permissionMode: 'yolo', modelMode: 'gpt-5.5', effortLevel: 'high' },
        });
    });

    it('migrates legacy drafts with shared mode fields to the draft agent', () => {
        const draft = parseNewSessionDraft({
            input: '',
            agentType: 'claude',
            permissionMode: 'bypassPermissions',
            modelMode: 'opus',
            effortLevel: null,
            sessionType: 'simple',
            updatedAt: 42,
        });

        expect(draft!.agentModes).toEqual({
            claude: { permissionMode: 'bypassPermissions', modelMode: 'opus', effortLevel: null },
        });
    });

    it('leaves agentModes empty when a legacy draft has no mode selections', () => {
        const draft = parseNewSessionDraft({
            input: '',
            agentType: 'claude',
            sessionType: 'simple',
            updatedAt: 42,
        });

        expect(draft!.agentModes).toEqual({});
    });

    it('returns null for non-object payloads', () => {
        expect(parseNewSessionDraft(null)).toBeNull();
        expect(parseNewSessionDraft('nope')).toBeNull();
    });
});
