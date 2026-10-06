import { describe, expect, it } from 'vitest';

import { resolveSessionMemoryScope } from './memoryScope';

describe('resolveSessionMemoryScope', () => {
    it('uses the authenticated project binding for project sessions', () => {
        expect(resolveSessionMemoryScope({
            env: {
                HAPPY_CHECKPOINT_SPAWN_CONTEXT: JSON.stringify({
                    schemaVersion: 1,
                    projectId: 'project-a',
                    worktreeId: 'worktree-a',
                    checkpointRoot: '/private/checkpoint',
                }),
            },
            projectPath: '/private/project-a',
            sessionId: 'session-a',
        })).toEqual({
            kind: 'project',
            scopeId: 'project-a',
            projectPath: '/private/project-a',
        });
    });

    it('keeps an unbound chat session ephemeral instead of treating cwd as a project', () => {
        expect(resolveSessionMemoryScope({
            env: {},
            projectPath: '/private/chats/chat-a',
            sessionId: 'session-a',
        })).toEqual({ kind: 'session', scopeId: 'session-a' });
    });

    it('fails closed when the inherited project binding is malformed', () => {
        expect(resolveSessionMemoryScope({
            env: { HAPPY_CHECKPOINT_SPAWN_CONTEXT: '{"projectId":"spoofed"}' },
            projectPath: '/private/chats/chat-a',
            sessionId: 'session-a',
        })).toEqual({ kind: 'session', scopeId: 'session-a' });
    });
});
