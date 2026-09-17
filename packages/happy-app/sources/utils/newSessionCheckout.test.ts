import { describe, expect, it, vi } from 'vitest';

// Reached through sessionUtils' path formatter, and it drags React Native in
// with it. Nothing here reads a translation.
vi.mock('@/text', () => ({ t: (key: string) => key }));

import { newSessionLikeSession } from './newSessionCheckout';
import type { Session } from '@/sync/storageTypes';

// Loose on purpose: these fixtures carry only the handful of metadata fields
// the helper reads, not the full synced shape.
function session(overrides: Record<string, unknown>): Session {
    return {
        id: 'session-1',
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        metadata: null,
        ...overrides,
    } as Session;
}

describe('newSessionLikeSession', () => {
    it('starts in the chat’s own directory, worktree and all', () => {
        const overrides = newSessionLikeSession(session({
            metadata: {
                machineId: 'machine-1',
                homeDir: '/Users/kirill',
                path: '/Users/kirill/happy/.dev/worktree/fix',
                flavor: 'codex',
            },
            permissionMode: 'auto',
            modelMode: 'gpt-5',
            effortLevel: 'high',
        }));

        // The point of asking from inside a checkout is a sibling in that same
        // checkout, so no worktree is picked or created on the way.
        expect(overrides.selectedPath).toBe('~/happy/.dev/worktree/fix');
        expect(overrides.sessionType).toBe('simple');
        expect(overrides.worktreeKey).toBeNull();
        expect(overrides.selectedMachineId).toBe('machine-1');
        expect(overrides.agentType).toBe('codex');
        expect(overrides.permissionMode).toBe('auto');
        expect(overrides.modelMode).toBe('gpt-5');
        expect(overrides.effortLevel).toBe('high');
        expect(overrides.happyAgentTarget).toBeNull();
    });

    it('never carries the composer’s draft prompt into a start nobody typed', () => {
        const overrides = newSessionLikeSession(session({
            metadata: { machineId: 'machine-1', path: '/tmp/project' },
        }));

        expect(overrides.input).toBe('');
        expect(overrides.attachments).toEqual([]);
    });

    it('falls back to Claude for an agent the draft cannot name', () => {
        expect(newSessionLikeSession(session({
            metadata: { path: '/tmp/project', flavor: 'something-new' },
        })).agentType).toBe('claude');
    });

    it('sends Happy Agent to the workspace by identity, not by path', () => {
        const overrides = newSessionLikeSession(session({
            metadata: {
                client: { id: 'rig', name: 'Happy Agent', version: 'test' },
                machineId: 'machine-1',
                path: '/Users/kirill/happy-worktrees/fix',
                project: { id: 'project-1', kind: 'regular', name: 'happy' },
                workspace: { id: 'workspace-1', name: 'fix' },
            },
        }));

        expect(overrides.agentType).toBe('rig');
        // A directory Happy Agent already owns would be imported as a second
        // project; the catalog id is what names the checkout it really is.
        expect(overrides.happyAgentTarget).toEqual({ kind: 'workspace', id: 'workspace-1' });
    });

    it('sends Happy Agent to the project when the chat runs in its own checkout', () => {
        expect(newSessionLikeSession(session({
            metadata: {
                client: { id: 'rig', name: 'Happy Agent', version: 'test' },
                path: '/Users/kirill/happy',
                project: { id: 'project-1', kind: 'regular', name: 'happy' },
            },
        })).happyAgentTarget).toEqual({ kind: 'project', id: 'project-1' });
    });

    it('reads Happy Agent’s live picks when the session mirrors none of them', () => {
        const overrides = newSessionLikeSession(session({
            metadata: {
                client: { id: 'rig', name: 'Happy Agent', version: 'test' },
                path: '/Users/kirill/happy',
                project: { id: 'project-1', kind: 'regular', name: 'happy' },
                currentOperatingModeCode: 'plan',
                currentModelProviderId: 'anthropic',
                currentModelCode: 'opus',
                currentThoughtLevelCode: 'think',
                thoughtLevels: [{ code: 'think', name: 'Think' }],
            },
        }));

        expect(overrides.permissionMode).toBe('plan');
        expect(overrides.modelMode).toBe('anthropic:opus');
        expect(overrides.effortLevel).toBe('think');
    });
});
