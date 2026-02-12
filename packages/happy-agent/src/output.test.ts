import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatSessionTable, formatSessionStatus, formatJson } from './output';
import type { DecryptedSession } from './api';

// Mock chalk to pass through text without ANSI codes for easier testing
vi.mock('chalk', () => {
    const passthrough = (s: string) => s;
    const chalkMock: Record<string, unknown> = {
        default: new Proxy({}, {
            get: (_target, prop) => {
                if (prop === 'bold') return passthrough;
                if (prop === 'green') return passthrough;
                if (prop === 'yellow') return passthrough;
                if (prop === 'dim') return passthrough;
                return passthrough;
            },
        }),
    };
    return chalkMock;
});

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
    it('should return "No sessions found." when sessions array is empty', () => {
        expect(formatSessionTable([])).toBe('No sessions found.');
    });

    it('should display a table with headers for sessions', () => {
        const sessions = [makeSession()];
        const output = formatSessionTable(sessions);

        expect(output).toContain('ID');
        expect(output).toContain('NAME');
        expect(output).toContain('PATH');
        expect(output).toContain('STATUS');
        expect(output).toContain('LAST ACTIVE');
    });

    it('should truncate session IDs to 8 characters', () => {
        const sessions = [makeSession({ id: 'abcdef1234567890abcdef' })];
        const output = formatSessionTable(sessions);

        expect(output).toContain('abcdef12');
        expect(output).not.toContain('abcdef1234567890abcdef');
    });

    it('should display session name from summary or tag', () => {
        const sessions = [
            makeSession({ metadata: { summary: 'My Summary', tag: 'my-tag', path: '/tmp' } }),
        ];
        const output = formatSessionTable(sessions);
        expect(output).toContain('My Summary');
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
        // name and path should both be "-"
        const lines = output.split('\n');
        const dataLine = lines[2]; // skip header and separator
        expect(dataLine).toContain('-');
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
        const lines = output.split('\n');
        // header + separator + 3 data rows
        expect(lines.length).toBe(5);
    });
});

describe('formatSessionStatus', () => {
    it('should display session ID', () => {
        const session = makeSession();
        const output = formatSessionStatus(session);
        expect(output).toContain('Session: ');
        expect(output).toContain(session.id);
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
        expect(output).toContain('Tag: my-tag');
        expect(output).toContain('Summary: My project session');
        expect(output).toContain('Path: /home/user/project');
        expect(output).toContain('Host: my-machine');
        expect(output).toContain('Lifecycle: running');
    });

    it('should display active status', () => {
        const session = makeSession({ active: true });
        const output = formatSessionStatus(session);
        expect(output).toContain('Active: yes');
    });

    it('should display inactive status', () => {
        const session = makeSession({ active: false });
        const output = formatSessionStatus(session);
        expect(output).toContain('Active: no');
    });

    it('should display agent state as idle when not busy', () => {
        const session = makeSession({
            agentState: { controlledByUser: false, requests: [] },
        });
        const output = formatSessionStatus(session);
        expect(output).toContain('Agent: idle');
    });

    it('should display agent state as busy when controlledByUser is true', () => {
        const session = makeSession({
            agentState: { controlledByUser: true, requests: [] },
        });
        const output = formatSessionStatus(session);
        expect(output).toContain('Agent: busy');
    });

    it('should display pending requests count', () => {
        const session = makeSession({
            agentState: { controlledByUser: true, requests: [{}, {}, {}] },
        });
        const output = formatSessionStatus(session);
        expect(output).toContain('Pending Requests: 3');
    });

    it('should display "no state" when agentState is null', () => {
        const session = makeSession({ agentState: null });
        const output = formatSessionStatus(session);
        expect(output).toContain('Agent: no state');
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
