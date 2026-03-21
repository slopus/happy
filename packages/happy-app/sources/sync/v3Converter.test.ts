import { describe, it, expect } from 'vitest';
import { isV3Envelope, convertV3ToAppMessages } from './v3Converter';

// Bypasses branded type checks in test fixtures
const convert = (msg: any) => convertV3ToAppMessages({ v: 3, message: msg });

const s = 'ses_test';
const u = 'msg_user';
const a = 'msg_asst';
const asstInfo = (extra?: any) => ({
    id: a, sessionID: s, role: 'assistant', time: { created: 1000 },
    parentID: u, modelID: 'x', providerID: 'x', agent: 'build',
    path: { cwd: '/', root: '/' }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...extra,
});

describe('v3Converter', () => {
    describe('isV3Envelope', () => {
        it('detects v3', () => {
            expect(isV3Envelope({ v: 3, message: { info: {}, parts: [] } })).toBe(true);
        });
        it('rejects legacy', () => {
            expect(isV3Envelope({ role: 'user', content: { type: 'text' } })).toBe(false);
            expect(isV3Envelope(null)).toBe(false);
            expect(isV3Envelope({ v: 2 })).toBe(false);
        });
    });

    it('user message → UserTextMessage', () => {
        const msgs = convert({
            info: { id: u, sessionID: s, role: 'user', time: { created: 1000 }, agent: 'build', model: { providerID: 'anthropic', modelID: 'sonnet' } },
            parts: [{ id: 'p1', sessionID: s, messageID: u, type: 'text', text: 'Hello' }],
        });
        expect(msgs).toHaveLength(1);
        expect(msgs[0].kind).toBe('user-text');
        if (msgs[0].kind === 'user-text') expect(msgs[0].text).toBe('Hello');
    });

    it('assistant text → AgentTextMessage', () => {
        const msgs = convert({
            info: asstInfo({ finish: 'stop' }),
            parts: [
                { id: 'ps', sessionID: s, messageID: a, type: 'step-start' },
                { id: 'p1', sessionID: s, messageID: a, type: 'text', text: 'Answer.' },
                { id: 'pf', sessionID: s, messageID: a, type: 'step-finish', reason: 'stop', cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
            ],
        });
        expect(msgs).toHaveLength(1);
        expect(msgs[0].kind).toBe('agent-text');
        if (msgs[0].kind === 'agent-text') expect(msgs[0].isThinking).toBe(false);
    });

    it('reasoning → thinking AgentTextMessage', () => {
        const msgs = convert({
            info: asstInfo(),
            parts: [{ id: 'p1', sessionID: s, messageID: a, type: 'reasoning', text: 'Thinking...', time: { start: 1000 } }],
        });
        expect(msgs).toHaveLength(1);
        if (msgs[0].kind === 'agent-text') expect(msgs[0].isThinking).toBe(true);
    });

    it('completed tool → ToolCallMessage', () => {
        const msgs = convert({
            info: asstInfo({ finish: 'tool-calls' }),
            parts: [{
                id: 'p1', sessionID: s, messageID: a,
                type: 'tool', callID: 'c1', tool: 'writeFile',
                state: { status: 'completed', input: { path: 'x' }, output: 'Done', title: 'writeFile', metadata: {}, time: { start: 1000, end: 1500 } },
            }],
        });
        expect(msgs).toHaveLength(1);
        expect(msgs[0].kind).toBe('tool-call');
        if (msgs[0].kind === 'tool-call') {
            expect(msgs[0].tool.state).toBe('completed');
            expect(msgs[0].tool.result).toBe('Done');
        }
    });

    it('blocked tool → running with pending permission', () => {
        const msgs = convert({
            info: asstInfo(),
            parts: [{
                id: 'p1', sessionID: s, messageID: a,
                type: 'tool', callID: 'c1', tool: 'writeFile',
                state: {
                    status: 'blocked', input: { path: 'x' }, time: { start: 1000 },
                    block: { type: 'permission', id: 'per1', permission: 'edit', patterns: ['x'], always: ['*'], metadata: {} },
                },
            }],
        });
        if (msgs[0].kind === 'tool-call') {
            expect(msgs[0].tool.state).toBe('running');
            expect(msgs[0].tool.permission?.status).toBe('pending');
        }
    });

    it('completed tool with resolved permission', () => {
        const msgs = convert({
            info: asstInfo(),
            parts: [{
                id: 'p1', sessionID: s, messageID: a,
                type: 'tool', callID: 'c1', tool: 'writeFile',
                state: {
                    status: 'completed', input: {}, output: 'Done', title: 'w', metadata: {},
                    time: { start: 1000, end: 2000 },
                    block: { type: 'permission', id: 'per1', permission: 'edit', patterns: ['x'], always: ['*'], metadata: {}, decision: 'once', decidedAt: 1500 },
                },
            }],
        });
        if (msgs[0].kind === 'tool-call') {
            expect(msgs[0].tool.permission?.status).toBe('approved');
            expect(msgs[0].tool.permission?.decision).toBe('approved');
            expect(msgs[0].tool.permission?.date).toBe(1500);
        }
    });

    it('error tool with rejected permission', () => {
        const msgs = convert({
            info: asstInfo(),
            parts: [{
                id: 'p1', sessionID: s, messageID: a,
                type: 'tool', callID: 'c1', tool: 'writeFile',
                state: {
                    status: 'error', input: {}, error: 'Rejected',
                    time: { start: 1000, end: 1500 },
                    block: { type: 'permission', id: 'per1', permission: 'edit', patterns: ['x'], always: ['*'], metadata: {}, decision: 'reject', decidedAt: 1400 },
                },
            }],
        });
        if (msgs[0].kind === 'tool-call') {
            expect(msgs[0].tool.state).toBe('error');
            expect(msgs[0].tool.permission?.status).toBe('denied');
        }
    });

    it('skips structural parts', () => {
        const msgs = convert({
            info: asstInfo(),
            parts: [
                { id: 'p1', sessionID: s, messageID: a, type: 'step-start' },
                { id: 'p2', sessionID: s, messageID: a, type: 'snapshot', snapshot: 'abc' },
                { id: 'p3', sessionID: s, messageID: a, type: 'patch', hash: 'def', files: ['a.ts'] },
                { id: 'p4', sessionID: s, messageID: a, type: 'step-finish', reason: 'stop', cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
            ],
        });
        expect(msgs).toHaveLength(0);
    });
});
