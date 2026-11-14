import { describe, expect, it } from 'vitest';
import type { AgentDefaultOverrides } from '@/sync/agentDefaults';
import type { NewSessionDraft } from '@/sync/persistence';
import { resolveAgentLaunchConfig } from './resolveAgentLaunchConfig';
import type { AgentLauncher } from './launchAgent';

const persistedAgent: AgentLauncher = {
    id: 'agent-1',
    name: 'Agent',
    glyph: 'A',
    color: '#5e5791',
    machineId: 'machine-1',
    path: '~/work',
    kind: 'standard',
    spaceType: 'default',
    imageStyleIds: [],
    imageVariantsPerStyle: 1,
    presets: [],
};

const draft: NewSessionDraft = {
    input: 'old input',
    selectedMachineId: 'another-machine',
    selectedPath: '/another/path',
    agentType: 'opencode',
    permissionMode: 'default',
    modelMode: 'draft-model',
    effortLevel: 'high',
    sessionType: 'simple',
    worktreeKey: '__none__',
    updatedAt: 1,
};

const defaults: AgentDefaultOverrides = {
    codex: {
        permissionMode: 'read-only',
        modelMode: 'default-codex-model',
        effortLevel: 'medium',
    },
};

describe('resolveAgentLaunchConfig', () => {
    it('rejects retired saved engines and drafts without choosing an active provider', () => {
        expect(resolveAgentLaunchConfig({ agent: { ...persistedAgent, agentType: 'personal' }, draft, defaults }))
            .toEqual({ type: 'error', message: 'personal-agent-retired' });
        expect(resolveAgentLaunchConfig({ agent: persistedAgent, draft: { ...draft, agentType: 'personal' }, defaults }))
            .toEqual({ type: 'error', message: 'personal-agent-retired' });
    });
    it('prefers explicit runtime Agent overrides over the current draft', () => {
        const runtimeAgent: AgentLauncher = {
            ...persistedAgent,
            builtin: true,
            agentType: 'codex',
            permissionMode: 'yolo',
            modelMode: 'runtime-model',
            effortLevel: null,
        };

        expect(resolveAgentLaunchConfig({ agent: runtimeAgent, draft, defaults })).toEqual({
            type: 'success',
            agent: 'codex',
            permissionMode: 'yolo',
            modelMode: 'runtime-model',
            effortLevel: null,
        });
    });

    it('uses the current draft for persisted Agents without runtime overrides', () => {
        expect(resolveAgentLaunchConfig({ agent: persistedAgent, draft, defaults })).toEqual({
            type: 'success',
            agent: 'opencode',
            permissionMode: 'default',
            modelMode: 'draft-model',
            effortLevel: 'high',
        });
    });

    it('retains the canonical force-Codex inference for image-style Agents', () => {
        expect(resolveAgentLaunchConfig({
            agent: { ...persistedAgent, kind: 'image-styles', imageStyleIds: ['style-1'] },
            draft,
            defaults,
        })).toEqual({
            type: 'success',
            agent: 'codex',
            permissionMode: 'default',
            modelMode: 'draft-model',
            effortLevel: 'high',
        });
    });

    it('falls back to resolved Agent defaults when draft mode fields are absent', () => {
        const partialDraft = {
            ...draft,
            agentType: 'codex',
            permissionMode: undefined,
            modelMode: undefined,
            effortLevel: undefined,
        };

        expect(resolveAgentLaunchConfig({ agent: persistedAgent, draft: partialDraft, defaults })).toEqual({
            type: 'success',
            agent: 'codex',
            permissionMode: 'read-only',
            modelMode: 'default-codex-model',
            effortLevel: 'medium',
        });
    });

    it('returns an explicit failure for an invalid higher-precedence Agent type', () => {
        const invalidAgent = { ...persistedAgent, agentType: 'not-an-agent' } as unknown as AgentLauncher;

        expect(resolveAgentLaunchConfig({ agent: invalidAgent, draft, defaults })).toEqual({
            type: 'error',
            message: 'Invalid Agent type',
        });
    });

    it('returns an explicit failure when no Agent type is available', () => {
        const missingTypeDraft = { ...draft, agentType: undefined };

        expect(resolveAgentLaunchConfig({ agent: persistedAgent, draft: missingTypeDraft, defaults })).toEqual({
            type: 'error',
            message: 'Invalid Agent type',
        });
    });
});
