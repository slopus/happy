import { describe, it, expect } from 'vitest';
import { formatSessionTable, formatSessionStatus, formatMessageHistory, formatJson } from './output';
import type { DecryptedSession, DecryptedMessage } from './api';

function makeSession(overrides: Partial<DecryptedSession> = {}): DecryptedSession {
    return {
        id: 'abcdef1234567890',
        seq: 1,
        createdAt: Date.now() - 3600_000,
        updatedAt: Date.now() - 1800_000,
        active: true,
        activeAt: Date.now() - 60_000,
        metadata: { tag: 'test-session', path: '/home/user/project', summary: 'Test session' },
        agentState: null,
        dataEncryptionKey: null,
        encryption: { key: new Uint8Array(32), variant: 'dataKey' as const },
        ...overrides,
    };
}

describe('formatSessionTable', () => {
    it('should return markdown summary when sessions array is empty', () => {
        const output = formatSessionTable([]);
        expect(output).toContain('## Sessions');
        expect(output).toContain('- Total: 0');
    });

    it('should display markdown list sections for sessions', () => {
        const sessions = [makeSession()];
        const output = formatSessionTable(sessions);

        expect(output).toContain('### Session 1');
        expect(output).toContain(`- ID: \`${sessions[0].id}\``);
        expect(output).toContain('- Name: Test session');
        expect(output).toContain('- Path: /home/user/project');
    });

    it('should display full session IDs for agent-friendly parsing', () => {
        const sessions = [makeSession({ id: 'abcdef1234567890abcdef' })];
        const output = formatSessionTable(sessions);

        expect(output).toContain('abcdef1234567890abcdef');
    });

    it('should display session name from summary or tag', () => {
        const sessions = [
            makeSession({ metadata: { summary: 'My Summary', tag: 'my-tag', path: '/tmp' } }),
        ];
        const output = formatSessionTable(sessions);
        expect(output).toContain('My Summary');
    });

    it('should display session name from summary.text object shape', () => {
        const sessions = [
            makeSession({
                metadata: {
                    summary: { text: 'Summary from object', updatedAt: 1700000000000 },
                    tag: 'my-tag',
                    path: '/tmp',
                },
            }),
        ];
        const output = formatSessionTable(sessions);
        expect(output).toContain('Summary from object');
        expect(output).not.toContain('[object Object]');
    });

    it('should fall back to tag when no summary', () => {
        const sessions = [
            makeSession({ metadata: { tag: 'my-tag', path: '/tmp' } }),
        ];
        const output = formatSessionTable(sessions);
        expect(output).toContain('my-tag');
    });

    it('should display active/inactive status', () => {
        const sessions = [
            makeSession({ active: true }),
            makeSession({ id: 'xyz789abcdef0000', active: false }),
        ];
        const output = formatSessionTable(sessions);
        expect(output).toContain('active');
        expect(output).toContain('inactive');
    });

    it('should display path from metadata', () => {
        const sessions = [
            makeSession({ metadata: { path: '/home/user/my-project', tag: 'test' } }),
        ];
        const output = formatSessionTable(sessions);
        expect(output).toContain('/home/user/my-project');
    });

    it('should display "-" for missing metadata fields', () => {
        const sessions = [makeSession({ metadata: {} })];
        const output = formatSessionTable(sessions);
        expect(output).toContain('- Name: -');
        expect(output).toContain('- Path: -');
    });

    it('should handle null metadata gracefully', () => {
        const sessions = [makeSession({ metadata: null })];
        const output = formatSessionTable(sessions);
        expect(output).toContain('-');
    });

    it('should display multiple sessions', () => {
        const sessions = [
            makeSession({ id: 'session-1-abc' }),
            makeSession({ id: 'session-2-def' }),
            makeSession({ id: 'session-3-ghi' }),
        ];
        const output = formatSessionTable(sessions);
        const sectionLines = output.split('\n').filter(line => line.startsWith('### Session '));
        expect(sectionLines.length).toBe(3);
    });
});

describe('formatSessionStatus', () => {
    it('should display session ID', () => {
        const session = makeSession();
        const output = formatSessionStatus(session);
        expect(output).toContain('## Session Status');
        expect(output).toContain(`- Session ID: \`${session.id}\``);
    });

    it('should display metadata fields', () => {
        const session = makeSession({
            metadata: {
                tag: 'my-tag',
                summary: 'My project session',
                path: '/home/user/project',
                host: 'my-machine',
                lifecycleState: 'running',
            },
        });
        const output = formatSessionStatus(session);
        expect(output).toContain('- Tag: my-tag');
        expect(output).toContain('- Summary: My project session');
        expect(output).toContain('- Path: /home/user/project');
        expect(output).toContain('- Host: my-machine');
        expect(output).toContain('- Lifecycle: running');
    });

    it('should display summary from summary.text object shape', () => {
        const session = makeSession({
            metadata: {
                tag: 'my-tag',
                summary: { text: 'Object summary value', updatedAt: 1700000000000 },
                path: '/home/user/project',
            },
        });
        const output = formatSessionStatus(session);
        expect(output).toContain('- Summary: Object summary value');
        expect(output).not.toContain('[object Object]');
    });

    it('should display active status', () => {
        const session = makeSession({ active: true });
        const output = formatSessionStatus(session);
        expect(output).toContain('- Active: yes');
    });

    it('should display inactive status', () => {
        const session = makeSession({ active: false });
        const output = formatSessionStatus(session);
        expect(output).toContain('- Active: no');
    });

    it('should display agent state as idle when not busy', () => {
        const session = makeSession({
            agentState: { controlledByUser: false, requests: {} },
        });
        const output = formatSessionStatus(session);
        expect(output).toContain('- Agent: idle');
    });

    it('should display agent state as busy when controlledByUser is true', () => {
        const session = makeSession({
            agentState: { controlledByUser: true, requests: {} },
        });
        const output = formatSessionStatus(session);
        expect(output).toContain('- Agent: busy');
    });

    it('should display pending requests count', () => {
        const session = makeSession({
            agentState: { controlledByUser: true, requests: { 'r1': {}, 'r2': {}, 'r3': {} } },
        });
        const output = formatSessionStatus(session);
        expect(output).toContain('- Pending Requests: 3');
    });

    it('should display "no state" when agentState is null', () => {
        const session = makeSession({ agentState: null });
        const output = formatSessionStatus(session);
        expect(output).toContain('- Agent: no state');
    });

    it('should omit missing optional metadata fields', () => {
        const session = makeSession({ metadata: {} });
        const output = formatSessionStatus(session);
        expect(output).not.toContain('Tag:');
        expect(output).not.toContain('Summary:');
        expect(output).not.toContain('Path:');
        expect(output).not.toContain('Host:');
    });
});

describe('formatMessageHistory', () => {
    function makeMessage(overrides: Partial<DecryptedMessage> = {}): DecryptedMessage {
        return {
            id: 'msg-1',
            seq: 1,
            content: { role: 'user', content: { type: 'text', text: 'Hello' } },
            localId: null,
            createdAt: 1700000000000,
            updatedAt: 1700000000000,
            ...overrides,
        };
    }

    it('should return markdown summary when messages array is empty', () => {
        const output = formatMessageHistory([]);
        expect(output).toContain('## Message History');
        expect(output).toContain('- Count: 0');
    });

    it('should display user messages with role and text', () => {
        const messages = [makeMessage()];
        const output = formatMessageHistory(messages);
        expect(output).toContain('### Message 1');
        expect(output).toContain('user');
        expect(output).toContain('Hello');
    });

    it('should display assistant messages', () => {
        const messages = [makeMessage({
            content: { role: 'assistant', content: { type: 'text', text: 'Hi there!' } },
        })];
        const output = formatMessageHistory(messages);
        expect(output).toContain('assistant');
        expect(output).toContain('Hi there!');
    });

    it('should display multiple messages', () => {
        const messages = [
            makeMessage({ id: 'msg-1', content: { role: 'user', content: { type: 'text', text: 'Hello' } }, createdAt: 1000 }),
            makeMessage({ id: 'msg-2', content: { role: 'assistant', content: { type: 'text', text: 'Hi!' } }, createdAt: 2000 }),
        ];
        const output = formatMessageHistory(messages);
        expect(output).toContain('### Message 1');
        expect(output).toContain('### Message 2');
        expect(output).toContain('Hello');
        expect(output).toContain('Hi!');
    });

    it('should handle string content directly', () => {
        const messages = [makeMessage({
            content: { role: 'user', content: 'Plain text message' },
        })];
        const output = formatMessageHistory(messages);
        expect(output).toContain('Plain text message');
    });

    it('should handle null content by showing JSON', () => {
        const messages = [makeMessage({ content: null })];
        const output = formatMessageHistory(messages);
        expect(output).toContain('unknown');
        expect(output).toContain('null');
    });

    it('should handle unknown role gracefully', () => {
        const messages = [makeMessage({
            content: { role: 'system', content: { type: 'text', text: 'System message' } },
        })];
        const output = formatMessageHistory(messages);
        expect(output).toContain('system');
        expect(output).toContain('System message');
    });
});

describe('formatJson', () => {
    it('should format data as pretty JSON', () => {
        const data = { id: 'abc', name: 'test' };
        const output = formatJson(data);
        expect(output).toBe(JSON.stringify(data, null, 2));
    });

    it('should handle arrays', () => {
        const data = [1, 2, 3];
        const output = formatJson(data);
        expect(output).toBe(JSON.stringify(data, null, 2));
    });

    it('should handle null', () => {
        expect(formatJson(null)).toBe('null');
    });

    it('should handle nested objects', () => {
        const data = { a: { b: { c: 'deep' } } };
        const output = formatJson(data);
        expect(JSON.parse(output)).toEqual(data);
    });
});
