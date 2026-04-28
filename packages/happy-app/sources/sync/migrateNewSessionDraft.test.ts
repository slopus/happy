/**
 * Tests for the one-shot MMKV migration that resets corrupted `agentType`
 * values in the new-session draft back to 'claude'.
 *
 * Background: A bug in the availableAgents override effect persisted fallback
 * agent types (e.g. 'openclaw', 'gemini') to MMKV when Claude was temporarily
 * unavailable. The main fix prevents future corruption, but existing devices
 * may still have corrupted drafts. This migration cleans them up on app startup.
 */

import { describe, it, expect } from 'vitest';
import { migrateNewSessionDraftAgentType } from './migrateNewSessionDraft';
import type { NewSessionDraft } from './persistence';

function makeDraft(overrides: Partial<NewSessionDraft> = {}): NewSessionDraft {
    return {
        input: '',
        selectedMachineId: null,
        selectedPath: null,
        agentType: 'claude',
        permissionMode: 'default',
        modelMode: 'default',
        sessionType: 'simple',
        worktreeKey: null,
        updatedAt: Date.now(),
        ...overrides,
    };
}

describe('migrateNewSessionDraftAgentType', () => {
    it('returns draft unchanged when agentType is already claude', () => {
        const draft = makeDraft({ agentType: 'claude' });
        const result = migrateNewSessionDraftAgentType(draft);
        expect(result!.agentType).toBe('claude');
    });

    it('resets agentType to claude when it is openclaw', () => {
        const draft = makeDraft({ agentType: 'openclaw' });
        const result = migrateNewSessionDraftAgentType(draft);
        expect(result!.agentType).toBe('claude');
    });

    it('resets agentType to claude when it is gemini', () => {
        const draft = makeDraft({ agentType: 'gemini' });
        const result = migrateNewSessionDraftAgentType(draft);
        expect(result!.agentType).toBe('claude');
    });

    it('resets agentType to claude when it is codex', () => {
        const draft = makeDraft({ agentType: 'codex' });
        const result = migrateNewSessionDraftAgentType(draft);
        expect(result!.agentType).toBe('claude');
    });

    it('preserves all other draft fields', () => {
        const draft = makeDraft({
            agentType: 'openclaw',
            input: 'hello world',
            selectedMachineId: 'machine-1',
            selectedPath: '/home/user/project',
            permissionMode: 'trusted',
            modelMode: 'sonnet',
            sessionType: 'worktree',
            worktreeKey: 'wt-1',
        });
        const result = migrateNewSessionDraftAgentType(draft);
        expect(result).not.toBeNull();
        expect(result!.agentType).toBe('claude');
        expect(result!.input).toBe('hello world');
        expect(result!.selectedMachineId).toBe('machine-1');
        expect(result!.selectedPath).toBe('/home/user/project');
        expect(result!.permissionMode).toBe('trusted');
        expect(result!.modelMode).toBe('sonnet');
        expect(result!.sessionType).toBe('worktree');
        expect(result!.worktreeKey).toBe('wt-1');
    });

    it('returns null when given null (no draft stored)', () => {
        const result = migrateNewSessionDraftAgentType(null);
        expect(result).toBeNull();
    });
});
