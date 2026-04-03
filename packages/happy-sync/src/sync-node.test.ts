import { beforeEach, describe, expect, it } from 'vitest';
import { SyncNode, type SyncNodeToken } from './sync-node';
import type { SessionAgentContent, SessionMessage } from './acpx-types';
import { encryptMessage, type KeyMaterial } from './encryption';
import type { SessionID, SessionInfo } from './sync-types';

function makeToken(
  scope: 'account' | 'session',
  sessionId?: string,
  permissions: SyncNodeToken['claims']['permissions'] = ['read', 'write'],
): SyncNodeToken {
  return {
    raw: 'test-token',
    claims: {
      scope: scope === 'account'
        ? { type: 'account' as const, userId: 'user1' }
        : { type: 'session' as const, userId: 'user1', sessionId: sessionId ?? 'ses_test' },
      permissions,
    },
  };
}

function makeKeyMaterial(): KeyMaterial {
  return {
    key: new Uint8Array(32).fill(1),
    variant: 'dataKey',
  };
}

function makeNode(
  scope: 'account' | 'session' = 'account',
  sessionId?: string,
  permissions: SyncNodeToken['claims']['permissions'] = ['read', 'write'],
): SyncNode {
  return new SyncNode('http://localhost:3005', makeToken(scope, sessionId, permissions), makeKeyMaterial());
}

const SESSION_ID = 'ses_test123' as SessionID;

function makeSessionInfo(sessionId: SessionID = SESSION_ID): SessionInfo {
  return {
    id: sessionId,
    projectID: 'proj_1',
    directory: '/repo',
    title: 'Test session',
    time: {
      created: Date.now(),
      updated: Date.now(),
    },
  };
}

function seedSession(
  node: SyncNode,
  metadata: unknown = null,
  agentState: unknown = null,
  sessionId: SessionID = SESSION_ID,
): void {
  node['upsertSessionInfo'](makeSessionInfo(sessionId), { metadata, agentState });
}

function makeUserMessage(id: string): SessionMessage {
  return {
    User: {
      id: `msg_${id}`,
      content: [{ Text: `User message ${id}` }],
    },
  };
}

function makeAgentMessage(
  id: string,
  content?: SessionAgentContent[],
  toolResults?: Record<string, unknown>,
): SessionMessage {
  return {
    Agent: {
      content: content ?? [{ Text: `Assistant response ${id}` }],
      tool_results: (toolResults ?? {}) as Record<string, never>,
    },
  };
}

describe('SyncNode state management', () => {
  let node: SyncNode;

  beforeEach(() => {
    node = makeNode();
  });

  describe('message insert', () => {
    it('inserts a SessionMessage into session state', () => {
      const msg = makeUserMessage('1');
      node.insertMessage(SESSION_ID, msg);

      const session = node.state.sessions.get(SESSION_ID as string);
      expect(session).toBeDefined();
      expect(session!.messages).toHaveLength(1);
      expect(session!.messages[0]).toEqual(msg);
    });

    it('creates session state if it does not exist', () => {
      expect(node.state.sessions.has(SESSION_ID as string)).toBe(false);
      node.insertMessage(SESSION_ID, makeUserMessage('1'));
      expect(node.state.sessions.has(SESSION_ID as string)).toBe(true);
    });

    it('preserves message order', () => {
      node.insertMessage(SESSION_ID, makeUserMessage('1'));
      node.insertMessage(SESSION_ID, makeAgentMessage('2'));
      node.insertMessage(SESSION_ID, makeUserMessage('3'));

      const session = node.state.sessions.get(SESSION_ID as string)!;
      expect(session.messages).toHaveLength(3);
      expect(session.messages[0]).toEqual(makeUserMessage('1'));
      expect(session.messages[2]).toEqual(makeUserMessage('3'));
    });
  });

  describe('message dedup', () => {
    it('deduplicates by user message id', () => {
      const msg = makeUserMessage('1');
      node.insertMessage(SESSION_ID, msg);
      node.insertMessage(SESSION_ID, msg);

      const session = node.state.sessions.get(SESSION_ID as string)!;
      expect(session.messages).toHaveLength(1);
    });

    it('updates existing user message when ids match', () => {
      node.insertMessage(SESSION_ID, makeUserMessage('1'));

      const updated: SessionMessage = {
        User: {
          id: 'msg_1',
          content: [{ Text: 'Updated text' }],
        },
      };
      node.upsertMessage(SESSION_ID, updated);

      const session = node.state.sessions.get(SESSION_ID as string)!;
      expect(session.messages).toHaveLength(1);
      expect(session.messages[0]).toEqual(updated);
    });

    it('deduplicates by localId when the same logical message is replayed', () => {
      node.insertMessage(SESSION_ID, makeUserMessage('1'), 'local_1');
      node.insertMessage(SESSION_ID, makeUserMessage('2'), 'local_1');

      const session = node.state.sessions.get(SESSION_ID as string)!;
      expect(session.messages).toHaveLength(1);
      expect(session.messages[0]).toEqual(makeUserMessage('2'));
    });
  });

  describe('permission state derivation', () => {
    it('reads pending permissions from metadata.pending.permissions', () => {
      seedSession(node, {
        lifecycleState: 'running',
        pending: {
          permissions: [{
            id: 'perm_1',
            callId: 'call_1',
            tool: 'Write',
            patterns: ['/test.ts'],
            metadata: { path: '/test.ts', content: 'hello' },
          }],
        },
      });

      const session = node.state.sessions.get(SESSION_ID as string)!;
      expect(session.permissions).toHaveLength(1);
      expect(session.permissions[0].permissionId).toBe('perm_1');
      expect(session.permissions[0].block.permission).toBe('Write');
      expect(session.permissions[0].resolved).toBe(false);
      expect(session.status).toEqual({ type: 'blocked', reason: 'permission' });
    });

    it('treats resolved metadata permissions as resolved', () => {
      seedSession(node, {
        lifecycleState: 'running',
        pending: {
          permissions: [{
            id: 'perm_1',
            callId: 'call_1',
            tool: 'Write',
            patterns: ['/test.ts'],
            metadata: { path: '/test.ts', content: 'hello' },
            decision: 'always',
            resolved: true,
          }],
        },
      });

      const session = node.state.sessions.get(SESSION_ID as string)!;
      expect(session.permissions).toHaveLength(1);
      expect(session.permissions[0].resolved).toBe(true);
      expect(session.status).toEqual({ type: 'running' });
    });
  });

  describe('question state derivation', () => {
    it('reads pending questions from metadata.pending.questions', () => {
      seedSession(node, {
        lifecycleState: 'idle',
        pending: {
          questions: [{
            id: 'q_1',
            callId: 'call_q1',
            questions: [{
              question: 'Which framework?',
              header: 'Framework selection',
              options: [
                { label: 'Vitest', description: 'Fast Vite-native testing' },
                { label: 'Jest', description: 'Popular JS test runner' },
              ],
            }],
          }],
        },
      });

      const session = node.state.sessions.get(SESSION_ID as string)!;
      expect(session.questions).toHaveLength(1);
      expect(session.questions[0].questionId).toBe('q_1');
      expect(session.questions[0].resolved).toBe(false);
      expect(session.status).toEqual({ type: 'blocked', reason: 'question' });
    });
  });

  describe('session status derivation', () => {
    it('idle when lifecycle state is idle', () => {
      seedSession(node, { lifecycleState: 'idle' });
      const session = node.state.sessions.get(SESSION_ID as string)!;
      expect(session.status).toEqual({ type: 'idle' });
    });

    it('running when lifecycle state is running', () => {
      seedSession(node, { lifecycleState: 'running' });
      const session = node.state.sessions.get(SESSION_ID as string)!;
      expect(session.status).toEqual({ type: 'running' });
    });

    it('completed when lifecycle state is archived', () => {
      seedSession(node, { lifecycleState: 'archived', archiveReason: 'Session ended' });
      const session = node.state.sessions.get(SESSION_ID as string)!;
      expect(session.status).toEqual({ type: 'completed' });
    });
  });

  describe('todo state derivation', () => {
    it('derives todos from TodoWrite tool results', () => {
      seedSession(node, { lifecycleState: 'running' });
      node.insertMessage(SESSION_ID, makeAgentMessage(
        'todo',
        [{
          ToolUse: {
            id: 'tu_todo',
            name: 'TodoWrite',
            raw_input: '{"todos":[]}',
            input: {},
            is_input_complete: true,
          },
        }],
        {
          tu_todo: {
            tool_use_id: 'tu_todo',
            tool_name: 'TodoWrite',
            is_error: false,
            content: { Text: '{"todos":[{"content":"Add due dates","status":"pending","priority":"high"},{"content":"Export to JSON","status":"completed"}]}' },
          },
        },
      ));

      const session = node.state.sessions.get(SESSION_ID as string)!;
      expect(session.todos).toEqual([
        { content: 'Add due dates', status: 'pending', priority: 'high' },
        { content: 'Export to JSON', status: 'completed', priority: 'medium' },
      ]);
    });
  });

  describe('session metadata handling', () => {
    it('decodes encrypted metadata envelopes with session info and opaque metadata', () => {
      const encoded = encryptMessage(makeKeyMaterial(), {
        session: {
          directory: '/repo',
          projectID: 'proj_1',
          title: 'Session Title',
          parentID: null,
        },
        metadata: {
          path: '/repo',
          host: 'test-machine',
        },
      });

      const decoded = node['decodeStoredSessionMetadata'](encoded);
      expect(decoded.sessionInfo).toEqual({
        directory: '/repo',
        projectID: 'proj_1',
        title: 'Session Title',
        parentID: null,
      });
      expect(decoded.metadata).toEqual({
        path: '/repo',
        host: 'test-machine',
      });
    });
  });

  describe('state change listeners', () => {
    it('notifies listeners on state change', () => {
      let notified = false;
      node.onStateChange(() => { notified = true; });

      node.insertMessage(SESSION_ID, makeUserMessage('1'));
      expect(notified).toBe(true);
    });
  });

  describe('message listeners', () => {
    it('notifies listeners for the correct session', () => {
      const received: SessionMessage[] = [];
      node.onMessage(SESSION_ID, (msg) => { received.push(msg); });

      node.insertMessage(SESSION_ID, makeUserMessage('1'));
      expect(received).toHaveLength(1);

      const otherSession = 'ses_other' as SessionID;
      node.insertMessage(otherSession, makeUserMessage('2'));
      expect(received).toHaveLength(1);
    });

    it('can hydrate state without notifying listeners', () => {
      const received: SessionMessage[] = [];
      node.onMessage(SESSION_ID, (msg) => { received.push(msg); });

      node.insertMessage(SESSION_ID, makeUserMessage('1'), undefined, {
        notifyListeners: false,
      });

      const session = node.state.sessions.get(SESSION_ID as string)!;
      expect(session.messages).toHaveLength(1);
      expect(received).toHaveLength(0);
    });
  });

  describe('token scope enforcement', () => {
    it('session-scoped node rejects access to other sessions', () => {
      const sessionNode = makeNode('session', 'ses_mine');

      expect(() => {
        sessionNode['assertSessionAccess']('ses_other' as SessionID);
      }).toThrow('Session-scoped token cannot access session ses_other');

      expect(() => {
        sessionNode['assertSessionAccess']('ses_mine' as SessionID);
      }).not.toThrow();
    });
  });

  describe('token permissions', () => {
    it('requires write permission for sendMessage', async () => {
      const readOnlyNode = makeNode('session', SESSION_ID as string, ['read']);

      await expect(readOnlyNode.sendMessage(SESSION_ID, makeUserMessage('1'))).rejects.toThrow(
        'sendMessage requires write permission',
      );
    });
  });
});
