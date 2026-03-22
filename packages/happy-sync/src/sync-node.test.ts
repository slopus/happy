/**
 * Level 0: SyncNode state unit tests
 *
 * Pure state transitions, dedup, seq tracking. No transport.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SyncNode, type SyncNodeToken } from './sync-node';
import { type KeyMaterial, encryptMessage, decryptMessage } from './encryption';
import type { MessageWithParts, SessionID, MessageID, PartID } from './protocol';

// ─── Test helpers ────────────────────────────────────────────────────────────

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

function makeUserMessage(id: string, sessionId: SessionID = SESSION_ID): MessageWithParts {
    return {
        info: {
            id: `msg_${id}` as MessageID,
            sessionID: sessionId,
            role: 'user' as const,
            time: { created: Date.now() },
            agent: 'claude',
            model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' },
        },
        parts: [{
            id: `prt_${id}` as PartID,
            sessionID: sessionId,
            messageID: `msg_${id}` as MessageID,
            type: 'text' as const,
            text: `User message ${id}`,
        }],
    };
}

function makeAssistantMessage(
    id: string,
    parentId: string,
    sessionId: SessionID = SESSION_ID,
    parts?: MessageWithParts['parts'],
): MessageWithParts {
    return {
        info: {
            id: `msg_${id}` as MessageID,
            sessionID: sessionId,
            role: 'assistant' as const,
            time: { created: Date.now() },
            parentID: `msg_${parentId}` as MessageID,
            modelID: 'claude-sonnet-4-20250514',
            providerID: 'anthropic',
            agent: 'claude',
            path: { cwd: '/project', root: '/project' },
            cost: 0.01,
            tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: parts ?? [{
            id: `prt_${id}` as PartID,
            sessionID: sessionId,
            messageID: `msg_${id}` as MessageID,
            type: 'step-start' as const,
        }, {
            id: `prt_${id}_text` as PartID,
            sessionID: sessionId,
            messageID: `msg_${id}` as MessageID,
            type: 'text' as const,
            text: `Assistant response ${id}`,
        }, {
            id: `prt_${id}_end` as PartID,
            sessionID: sessionId,
            messageID: `msg_${id}` as MessageID,
            type: 'step-finish' as const,
            reason: 'end_turn',
            cost: 0.01,
            tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
        }],
    };
}

function makeToolMessage(
    id: string,
    parentId: string,
    toolState: MessageWithParts['parts'][number] extends { type: 'tool' } ? never : unknown,
    sessionId: SessionID = SESSION_ID,
): MessageWithParts {
    return makeAssistantMessage(id, parentId, sessionId);
}

function makeBlockedToolPart(
    id: string,
    callId: string,
    blockType: 'permission' | 'question',
    sessionId: SessionID = SESSION_ID,
    messageId?: string,
): MessageWithParts['parts'][number] {
    const msgId = messageId ?? id;
    if (blockType === 'permission') {
        return {
            id: `prt_tool_${id}` as PartID,
            sessionID: sessionId,
            messageID: `msg_${msgId}` as MessageID,
            type: 'tool' as const,
            callID: callId,
            tool: 'Write',
            state: {
                status: 'blocked' as const,
                input: { path: '/test.ts', content: 'hello' },
                title: 'Write file',
                time: { start: Date.now() },
                block: {
                    type: 'permission' as const,
                    id: `perm_${id}`,
                    permission: 'Write',
                    patterns: ['/test.ts'],
                    always: ['Write'],
                    metadata: {},
                },
            },
        };
    }
    return {
        id: `prt_tool_${id}` as PartID,
        sessionID: sessionId,
        messageID: `msg_${msgId}` as MessageID,
        type: 'tool' as const,
        callID: callId,
        tool: 'AskUser',
        state: {
            status: 'blocked' as const,
            input: {},
            title: 'Ask user',
            time: { start: Date.now() },
            block: {
                type: 'question' as const,
                id: `q_${id}`,
                questions: [{
                    question: 'Which framework?',
                    header: 'Framework selection',
                    options: [
                        { label: 'Vitest', description: 'Fast Vite-native testing' },
                        { label: 'Jest', description: 'Meta testing framework' },
                    ],
                }],
            },
        },
    };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('SyncNode state management', () => {
    let node: SyncNode;

    beforeEach(() => {
        node = makeNode();
    });

    describe('message insert', () => {
        it('inserts a message into session state', () => {
            const msg = makeUserMessage('1');
            node.insertMessage(SESSION_ID, msg);

            const session = node.state.sessions.get(SESSION_ID as string);
            expect(session).toBeDefined();
            expect(session!.messages).toHaveLength(1);
            expect(session!.messages[0].info.id).toBe('msg_1');
        });

        it('creates session state if it does not exist', () => {
            expect(node.state.sessions.has(SESSION_ID as string)).toBe(false);
            node.insertMessage(SESSION_ID, makeUserMessage('1'));
            expect(node.state.sessions.has(SESSION_ID as string)).toBe(true);
        });

        it('preserves message order', () => {
            node.insertMessage(SESSION_ID, makeUserMessage('1'));
            node.insertMessage(SESSION_ID, makeAssistantMessage('2', '1'));
            node.insertMessage(SESSION_ID, makeUserMessage('3'));

            const session = node.state.sessions.get(SESSION_ID as string)!;
            expect(session.messages).toHaveLength(3);
            expect(session.messages[0].info.id).toBe('msg_1');
            expect(session.messages[1].info.id).toBe('msg_2');
            expect(session.messages[2].info.id).toBe('msg_3');
        });
    });

    describe('message dedup', () => {
        it('deduplicates by message ID (upsert)', () => {
            const msg1 = makeUserMessage('1');
            node.insertMessage(SESSION_ID, msg1);
            node.insertMessage(SESSION_ID, msg1);

            const session = node.state.sessions.get(SESSION_ID as string)!;
            expect(session.messages).toHaveLength(1);
        });

        it('updates existing message when IDs match', () => {
            const msg1 = makeUserMessage('1');
            node.insertMessage(SESSION_ID, msg1);

            const updated: MessageWithParts = {
                ...msg1,
                parts: [{
                    ...msg1.parts[0],
                    type: 'text' as const,
                    text: 'Updated text',
                } as MessageWithParts['parts'][number]],
            };
            node.upsertMessage(SESSION_ID, updated);

            const session = node.state.sessions.get(SESSION_ID as string)!;
            expect(session.messages).toHaveLength(1);
            const textPart = session.messages[0].parts[0];
            expect(textPart.type).toBe('text');
            if (textPart.type === 'text') {
                expect(textPart.text).toBe('Updated text');
            }
        });

        it('deduplicates by localId when the same logical message is replayed', () => {
            const msg = makeUserMessage('1');
            node.insertMessage(SESSION_ID, msg, 'local_1');

            // Insert a different message ID with the same localId.
            const msg2 = makeUserMessage('2');
            node.insertMessage(SESSION_ID, msg2, 'local_1');

            const session = node.state.sessions.get(SESSION_ID as string)!;
            expect(session.messages).toHaveLength(1);
            expect(session.messages[0].info.id).toBe('msg_1');
        });
    });

    describe('session isolation', () => {
        it('isolates messages between sessions', () => {
            const session1 = 'ses_1' as SessionID;
            const session2 = 'ses_2' as SessionID;

            node.insertMessage(session1, makeUserMessage('1', session1));
            node.insertMessage(session2, makeUserMessage('2', session2));

            expect(node.state.sessions.get(session1 as string)!.messages).toHaveLength(1);
            expect(node.state.sessions.get(session2 as string)!.messages).toHaveLength(1);
            expect(node.state.sessions.get(session1 as string)!.messages[0].info.id).toBe('msg_1');
            expect(node.state.sessions.get(session2 as string)!.messages[0].info.id).toBe('msg_2');
        });
    });

    describe('permission state derivation', () => {
        it('detects blocked permission from tool parts', () => {
            const blockedPart = makeBlockedToolPart('1', 'call_1', 'permission');
            const msg = makeAssistantMessage('1', '0', SESSION_ID, [
                {
                    id: 'prt_step' as PartID,
                    sessionID: SESSION_ID,
                    messageID: 'msg_1' as MessageID,
                    type: 'step-start' as const,
                },
                blockedPart,
            ]);

            node.insertMessage(SESSION_ID, msg);

            const session = node.state.sessions.get(SESSION_ID as string)!;
            expect(session.permissions).toHaveLength(1);
            expect(session.permissions[0].permissionId).toBe('perm_1');
            expect(session.permissions[0].resolved).toBe(false);
            expect(session.status).toEqual({ type: 'blocked', reason: 'permission' });
        });

        it('marks permission as resolved after decision message', () => {
            // First insert the assistant message with blocked tool
            const blockedPart = makeBlockedToolPart('1', 'call_1', 'permission');
            const assistantMsg = makeAssistantMessage('1', '0', SESSION_ID, [
                {
                    id: 'prt_step' as PartID,
                    sessionID: SESSION_ID,
                    messageID: 'msg_1' as MessageID,
                    type: 'step-start' as const,
                },
                blockedPart,
            ]);
            node.insertMessage(SESSION_ID, assistantMsg);

            // Now insert a decision message
            const decisionMsg: MessageWithParts = {
                info: {
                    id: 'msg_decision' as MessageID,
                    sessionID: SESSION_ID,
                    role: 'user' as const,
                    time: { created: Date.now() },
                    agent: 'user',
                    model: { providerID: 'user', modelID: 'user' },
                },
                parts: [{
                    id: 'prt_decision' as PartID,
                    sessionID: SESSION_ID,
                    messageID: 'msg_decision' as MessageID,
                    type: 'decision' as const,
                    targetMessageID: 'msg_1' as MessageID,
                    targetCallID: 'call_1',
                    permissionID: 'perm_1',
                    decision: 'once' as const,
                    decidedAt: Date.now(),
                }],
            };
            node.insertMessage(SESSION_ID, decisionMsg);

            const session = node.state.sessions.get(SESSION_ID as string)!;
            expect(session.permissions).toHaveLength(1);
            expect(session.permissions[0].resolved).toBe(true);
            // Status should no longer be blocked
            expect(session.status.type).not.toBe('blocked');
        });
    });

    describe('question state derivation', () => {
        it('detects blocked question from tool parts', () => {
            const blockedPart = makeBlockedToolPart('1', 'call_1', 'question');
            const msg = makeAssistantMessage('1', '0', SESSION_ID, [
                {
                    id: 'prt_step' as PartID,
                    sessionID: SESSION_ID,
                    messageID: 'msg_1' as MessageID,
                    type: 'step-start' as const,
                },
                blockedPart,
            ]);

            node.insertMessage(SESSION_ID, msg);

            const session = node.state.sessions.get(SESSION_ID as string)!;
            expect(session.questions).toHaveLength(1);
            expect(session.questions[0].questionId).toBe('q_1');
            expect(session.questions[0].resolved).toBe(false);
            expect(session.status).toEqual({ type: 'blocked', reason: 'question' });
        });

        it('marks question as resolved after answer message', () => {
            const blockedPart = makeBlockedToolPart('1', 'call_1', 'question');
            const assistantMsg = makeAssistantMessage('1', '0', SESSION_ID, [
                {
                    id: 'prt_step' as PartID,
                    sessionID: SESSION_ID,
                    messageID: 'msg_1' as MessageID,
                    type: 'step-start' as const,
                },
                blockedPart,
            ]);
            node.insertMessage(SESSION_ID, assistantMsg);

            const answerMsg: MessageWithParts = {
                info: {
                    id: 'msg_answer' as MessageID,
                    sessionID: SESSION_ID,
                    role: 'user' as const,
                    time: { created: Date.now() },
                    agent: 'user',
                    model: { providerID: 'user', modelID: 'user' },
                },
                parts: [{
                    id: 'prt_answer' as PartID,
                    sessionID: SESSION_ID,
                    messageID: 'msg_answer' as MessageID,
                    type: 'answer' as const,
                    targetMessageID: 'msg_1' as MessageID,
                    targetCallID: 'call_1',
                    questionID: 'q_1',
                    answers: [['Vitest']],
                    decidedAt: Date.now(),
                }],
            };
            node.insertMessage(SESSION_ID, answerMsg);

            const session = node.state.sessions.get(SESSION_ID as string)!;
            expect(session.questions).toHaveLength(1);
            expect(session.questions[0].resolved).toBe(true);
            expect(session.status.type).not.toBe('blocked');
        });
    });

    describe('session status derivation', () => {
        it('idle when no messages', () => {
            node.insertMessage(SESSION_ID, makeUserMessage('1'));
            const session = node.state.sessions.get(SESSION_ID as string)!;
            expect(session.status).toEqual({ type: 'idle' });
        });

        it('running when tool is running', () => {
            const runningToolPart: MessageWithParts['parts'][number] = {
                id: 'prt_tool' as PartID,
                sessionID: SESSION_ID,
                messageID: 'msg_1' as MessageID,
                type: 'tool' as const,
                callID: 'call_1',
                tool: 'Read',
                state: {
                    status: 'running' as const,
                    input: { path: '/test.ts' },
                    time: { start: Date.now() },
                },
            };

            const msg = makeAssistantMessage('1', '0', SESSION_ID, [
                {
                    id: 'prt_step' as PartID,
                    sessionID: SESSION_ID,
                    messageID: 'msg_1' as MessageID,
                    type: 'step-start' as const,
                },
                runningToolPart,
            ]);

            node.insertMessage(SESSION_ID, msg);

            const session = node.state.sessions.get(SESSION_ID as string)!;
            expect(session.status).toEqual({ type: 'running' });
        });

        it('blocked takes precedence over running', () => {
            const runningPart: MessageWithParts['parts'][number] = {
                id: 'prt_running' as PartID,
                sessionID: SESSION_ID,
                messageID: 'msg_1' as MessageID,
                type: 'tool' as const,
                callID: 'call_run',
                tool: 'Read',
                state: {
                    status: 'running' as const,
                    input: {},
                    time: { start: Date.now() },
                },
            };
            const blockedPart = makeBlockedToolPart('1', 'call_block', 'permission');

            const msg = makeAssistantMessage('1', '0', SESSION_ID, [
                {
                    id: 'prt_step' as PartID,
                    sessionID: SESSION_ID,
                    messageID: 'msg_1' as MessageID,
                    type: 'step-start' as const,
                },
                runningPart,
                blockedPart,
            ]);

            node.insertMessage(SESSION_ID, msg);

            const session = node.state.sessions.get(SESSION_ID as string)!;
            expect(session.status).toEqual({ type: 'blocked', reason: 'permission' });
        });
    });

    describe('todo state derivation', () => {
        it('derives todos from TodoWrite tool parts and normalizes missing priority', () => {
            const todoToolPart: MessageWithParts['parts'][number] = {
                id: 'prt_todo' as PartID,
                sessionID: SESSION_ID,
                messageID: 'msg_1' as MessageID,
                type: 'tool' as const,
                callID: 'call_todo',
                tool: 'TodoWrite',
                state: {
                    status: 'completed' as const,
                    input: {
                        todos: [
                            { content: 'Add due dates', status: 'pending', priority: 'high' },
                            { content: 'Export to JSON', status: 'completed' },
                        ],
                    },
                    output: '{"ok":true}',
                    title: 'Update tasks',
                    metadata: {},
                    time: { start: Date.now(), end: Date.now() },
                },
            };

            node.insertMessage(SESSION_ID, makeAssistantMessage('1', '0', SESSION_ID, [
                {
                    id: 'prt_step' as PartID,
                    sessionID: SESSION_ID,
                    messageID: 'msg_1' as MessageID,
                    type: 'step-start' as const,
                },
                todoToolPart,
            ]));

            const session = node.state.sessions.get(SESSION_ID as string)!;
            expect(session.todos).toEqual([
                { content: 'Add due dates', status: 'pending', priority: 'high' },
                { content: 'Export to JSON', status: 'completed', priority: 'medium' },
            ]);
        });
    });

    describe('session metadata handling', () => {
        it('decodes encrypted metadata envelopes with session info and opaque metadata', () => {
            const encrypted = encryptMessage(makeKeyMaterial(), {
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

            const decoded = node['decodeStoredSessionMetadata'](encrypted);
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

        it('preserves session info when encrypted metadata updates arrive', async () => {
            node['upsertSessionInfo']({
                id: SESSION_ID,
                projectID: 'proj_1',
                directory: '/repo',
                title: 'Session Title',
                time: {
                    created: 100,
                    updated: 100,
                },
            });

            const encrypted = encryptMessage(makeKeyMaterial(), {
                session: {
                    directory: '/repo',
                    projectID: 'proj_1',
                    title: 'Session Title',
                    parentID: null,
                },
                metadata: {
                    host: 'updated-host',
                },
            });

            await node['handleSessionUpdate']({
                t: 'update-session',
                id: SESSION_ID,
                metadata: {
                    value: encrypted,
                    version: 2,
                },
            });

            const session = node.state.sessions.get(SESSION_ID as string)!;
            expect(session.info.projectID).toBe('proj_1');
            expect(session.info.directory).toBe('/repo');
            expect(session.info.title).toBe('Session Title');
            expect(session.metadata).toEqual({ host: 'updated-host' });
            expect(session.metadataVersion).toBe(2);
        });
    });

    describe('state change listeners', () => {
        it('notifies listeners on state change', () => {
            let notified = false;
            node.onStateChange(() => { notified = true; });

            node.insertMessage(SESSION_ID, makeUserMessage('1'));
            expect(notified).toBe(true);
        });

        it('unsubscribes correctly', () => {
            let count = 0;
            const unsub = node.onStateChange(() => { count++; });

            node.insertMessage(SESSION_ID, makeUserMessage('1'));
            expect(count).toBe(1);

            unsub();
            node.insertMessage(SESSION_ID, makeUserMessage('2'));
            expect(count).toBe(1);
        });
    });

    describe('message listeners', () => {
        it('notifies message listeners for the correct session', () => {
            const received: MessageWithParts[] = [];
            node.onMessage(SESSION_ID, (msg) => { received.push(msg); });

            node.insertMessage(SESSION_ID, makeUserMessage('1'));
            expect(received).toHaveLength(1);

            // Different session — should not trigger
            const otherSession = 'ses_other' as SessionID;
            node.insertMessage(otherSession, makeUserMessage('2', otherSession));
            expect(received).toHaveLength(1);
        });

        it('can hydrate state without notifying message listeners', () => {
            const received: MessageWithParts[] = [];
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
        it('account-scoped node can access any session', () => {
            const accountNode = makeNode('account');
            // Should not throw
            accountNode.insertMessage('ses_1' as SessionID, makeUserMessage('1', 'ses_1' as SessionID));
            accountNode.insertMessage('ses_2' as SessionID, makeUserMessage('2', 'ses_2' as SessionID));
        });

        it('session-scoped node rejects access to other sessions', () => {
            const sessionNode = makeNode('session', 'ses_mine');

            // assertSessionAccess is private, test via insertMessage + updateMessage pattern
            // insertMessage is public, but doesn't call assertSessionAccess — it allows any session
            // The actual enforcement is in sendMessage/updateMessage (which need network).
            // So we test the private method directly.
            expect(() => {
                sessionNode['assertSessionAccess']('ses_other' as SessionID);
            }).toThrow('Session-scoped token cannot access session ses_other');

            // Own session should work fine
            expect(() => {
                sessionNode['assertSessionAccess']('ses_mine' as SessionID);
            }).not.toThrow();
        });

        it('session-scoped node allows access to its own session', () => {
            const sessionNode = makeNode('session', 'ses_mine');
            // insertMessage works for the scoped session
            sessionNode.insertMessage('ses_mine' as SessionID, makeUserMessage('1', 'ses_mine' as SessionID));
            const session = sessionNode.state.sessions.get('ses_mine');
            expect(session).toBeDefined();
            expect(session!.messages).toHaveLength(1);
        });

        it('session-scoped listSessions only returns the scoped session', () => {
            const sessionNode = makeNode('session', 'ses_mine');

            sessionNode.insertMessage('ses_mine' as SessionID, makeUserMessage('1', 'ses_mine' as SessionID));
            sessionNode.insertMessage('ses_other' as SessionID, makeUserMessage('2', 'ses_other' as SessionID));

            expect(sessionNode.listSessions().map((session) => session.id)).toEqual(['ses_mine']);
        });
    });

    describe('token permissions', () => {
        it('requires admin permission for createSession', async () => {
            const readWriteNode = makeNode('account', undefined, ['read', 'write']);

            await expect(readWriteNode.createSession({
                directory: '/repo',
                projectID: 'proj_1',
                title: 'Missing admin',
            })).rejects.toThrow('createSession requires admin permission');
        });

        it('requires read permission for listSessions', () => {
            const writeOnlyNode = makeNode('account', undefined, ['write']);

            expect(() => writeOnlyNode.listSessions()).toThrow('listSessions requires read permission');
        });

        it('requires write permission for sendMessage', async () => {
            const readOnlyNode = makeNode('session', SESSION_ID as string, ['read']);

            await expect(readOnlyNode.sendMessage(SESSION_ID, makeUserMessage('1'))).rejects.toThrow(
                'sendMessage requires write permission',
            );
        });
    });
});

describe('SyncNode encryption round-trip', () => {
    it('encrypts and decrypts a message correctly', () => {
        const keyMaterial: KeyMaterial = {
            key: new Uint8Array(32).fill(42),
            variant: 'dataKey',
        };

        const original = {
            v: 3,
            message: {
                info: { id: 'msg_1', role: 'user', time: { created: 1000 } },
                parts: [{ id: 'prt_1', type: 'text', text: 'Hello' }],
            },
        };

        const encrypted = encryptMessage(keyMaterial, original);
        expect(typeof encrypted).toBe('string');
        expect(encrypted).not.toContain('Hello'); // Ciphertext should not be plaintext

        const decrypted = decryptMessage(keyMaterial, encrypted);
        expect(decrypted).toEqual(original);
    });

    it('returns null for wrong key', () => {
        const keyMaterial1: KeyMaterial = {
            key: new Uint8Array(32).fill(1),
            variant: 'dataKey',
        };
        const keyMaterial2: KeyMaterial = {
            key: new Uint8Array(32).fill(2),
            variant: 'dataKey',
        };

        const encrypted = encryptMessage(keyMaterial1, { test: true });
        const decrypted = decryptMessage(keyMaterial2, encrypted);
        expect(decrypted).toBeNull();
    });
});
