/**
 * v3 Protocol Integration Test
 *
 * Verifies the full v3 pipeline from the app's perspective:
 * pre-built v3 ProtocolEnvelope payloads → isV3Envelope → convertV3ToAppMessages
 *
 * Tests use realistic v3 payloads that match what the CLI mappers produce.
 * Each test covers a step from the exercise flow in
 * environments/lab-rat-todo-project/exercise-flow.md.
 */

import { describe, it, expect } from 'vitest';
import { isV3Envelope, convertV3ToAppMessages } from './v3Converter';

const convert = (msg: any) => convertV3ToAppMessages({ v: 3, message: msg });

const s = 'ses_integ';
const u = 'msg_user_01';
const a = 'msg_asst_01';
const asstInfo = (extra?: any) => ({
    id: a, sessionID: s, role: 'assistant',
    time: { created: 1000, completed: 2000 },
    parentID: u, modelID: 'claude-sonnet-4-6', providerID: 'anthropic',
    agent: 'build', path: { cwd: '/test', root: '/test' },
    cost: 0.008, tokens: { input: 4000, output: 300, reasoning: 0, cache: { read: 3500, write: 500 } },
    ...extra,
});

describe('v3 protocol integration', () => {

    // ── TRANSCRIPT ──────────────────────────────────────────────

    it('step 1: text response round trip', () => {
        const msgs = convert({
            info: asstInfo({ finish: 'stop' }),
            parts: [
                { id: 'ps', sessionID: s, messageID: a, type: 'step-start' },
                { id: 'p1', sessionID: s, messageID: a, type: 'text', text: 'This is a todo app with 4 files.' },
                { id: 'pf', sessionID: s, messageID: a, type: 'step-finish', reason: 'stop', cost: 0.008, tokens: { input: 4000, output: 300, reasoning: 0, cache: { read: 3500, write: 500 } } },
            ],
        });
        expect(msgs).toHaveLength(1);
        expect(msgs[0].kind).toBe('agent-text');
        if (msgs[0].kind === 'agent-text') {
            expect(msgs[0].text).toContain('todo app');
            expect(msgs[0].isThinking).toBe(false);
        }
    });

    it('step 2: reasoning shows as thinking', () => {
        const msgs = convert({
            info: asstInfo(),
            parts: [
                { id: 'ps', sessionID: s, messageID: a, type: 'step-start' },
                { id: 'p1', sessionID: s, messageID: a, type: 'reasoning', text: 'The Done filter has a bug...', time: { start: 1000, end: 1200 } },
                { id: 'p2', sessionID: s, messageID: a, type: 'text', text: 'The bug is on line 88.' },
                { id: 'pf', sessionID: s, messageID: a, type: 'step-finish', reason: 'stop', cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
            ],
        });
        expect(msgs).toHaveLength(2);
        expect(msgs[0].kind).toBe('agent-text');
        if (msgs[0].kind === 'agent-text') expect(msgs[0].isThinking).toBe(true);
        expect(msgs[1].kind).toBe('agent-text');
        if (msgs[1].kind === 'agent-text') expect(msgs[1].isThinking).toBe(false);
    });

    // ── PERMISSIONS ─────────────────────────────────────────────

    it('step 3: permission reject → tool error with denied', () => {
        const msgs = convert({
            info: asstInfo({ finish: 'tool-calls' }),
            parts: [{
                id: 'p1', sessionID: s, messageID: a,
                type: 'tool', callID: 'call_rej', tool: 'writeFile',
                state: {
                    status: 'error',
                    input: { path: 'app.js', content: 'fixed code' },
                    error: 'User rejected: show me the diff first',
                    time: { start: 1000, end: 1500 },
                    block: {
                        type: 'permission', id: 'per_1', permission: 'edit',
                        patterns: ['app.js'], always: ['*'], metadata: {},
                        decision: 'reject', decidedAt: 1400,
                    },
                },
            }],
        });
        expect(msgs).toHaveLength(1);
        if (msgs[0].kind === 'tool-call') {
            expect(msgs[0].tool.state).toBe('error');
            expect(msgs[0].tool.permission?.status).toBe('denied');
            expect(msgs[0].tool.permission?.decision).toBe('denied');
        }
    });

    it('step 4: permission allow once → completed with approved', () => {
        const msgs = convert({
            info: asstInfo({ finish: 'tool-calls' }),
            parts: [{
                id: 'p1', sessionID: s, messageID: a,
                type: 'tool', callID: 'call_ok', tool: 'writeFile',
                state: {
                    status: 'completed',
                    input: { path: 'app.js', content: 'item.done' },
                    output: 'Fixed Done filter on line 88',
                    title: 'writeFile app.js', metadata: {},
                    time: { start: 1000, end: 2000 },
                    block: {
                        type: 'permission', id: 'per_2', permission: 'edit',
                        patterns: ['app.js'], always: ['*'], metadata: {},
                        decision: 'once', decidedAt: 1500,
                    },
                },
            }],
        });
        if (msgs[0].kind === 'tool-call') {
            expect(msgs[0].tool.state).toBe('completed');
            expect(msgs[0].tool.permission?.status).toBe('approved');
            expect(msgs[0].tool.permission?.decision).toBe('approved');
            expect(msgs[0].tool.permission?.date).toBe(1500);
        }
    });

    it('step 5: permission allow always → approved_for_session', () => {
        const msgs = convert({
            info: asstInfo({ finish: 'tool-calls' }),
            parts: [{
                id: 'p1', sessionID: s, messageID: a,
                type: 'tool', callID: 'call_css', tool: 'writeFile',
                state: {
                    status: 'completed',
                    input: { path: 'styles.css' },
                    output: 'Added dark mode',
                    title: 'writeFile styles.css', metadata: {},
                    time: { start: 1000, end: 2000 },
                    block: {
                        type: 'permission', id: 'per_3', permission: 'edit',
                        patterns: ['styles.css'], always: ['*'], metadata: {},
                        decision: 'always', decidedAt: 1500,
                    },
                },
            }],
        });
        if (msgs[0].kind === 'tool-call') {
            expect(msgs[0].tool.permission?.decision).toBe('approved_for_session');
        }
    });

    it('step 6: auto-approved tool → no block field', () => {
        const msgs = convert({
            info: asstInfo({ finish: 'tool-calls' }),
            parts: [{
                id: 'p1', sessionID: s, messageID: a,
                type: 'tool', callID: 'call_auto', tool: 'writeFile',
                state: {
                    status: 'completed',
                    input: { path: 'index.html' },
                    output: 'Added toggle button',
                    title: 'writeFile index.html', metadata: {},
                    time: { start: 1000, end: 1800 },
                    // No block field — was auto-approved
                },
            }],
        });
        if (msgs[0].kind === 'tool-call') {
            expect(msgs[0].tool.state).toBe('completed');
            expect(msgs[0].tool.permission).toBeUndefined();
        }
    });

    // ── QUESTION ────────────────────────────────────────────────

    it('step 12: question blocked → pending, then answered → approved', () => {
        // First: blocked state (what app sees while waiting)
        const blockedMsgs = convert({
            info: asstInfo(),
            parts: [{
                id: 'p1', sessionID: s, messageID: a,
                type: 'tool', callID: 'call_q', tool: 'AskUserQuestion',
                state: {
                    status: 'blocked',
                    input: { question: 'Which test framework?' },
                    time: { start: 1000 },
                    block: {
                        type: 'question', id: 'q_1',
                        questions: [{
                            question: 'Which test framework?', header: 'Framework',
                            options: [{ label: 'Vitest', description: 'Fast' }, { label: 'Jest', description: 'Popular' }],
                        }],
                    },
                },
            }],
        });
        if (blockedMsgs[0].kind === 'tool-call') {
            expect(blockedMsgs[0].tool.state).toBe('running'); // UI shows running
            expect(blockedMsgs[0].tool.permission?.status).toBe('pending');
        }

        // Then: completed with answers
        const answeredMsgs = convert({
            info: asstInfo({ time: { created: 1000, completed: 3000 } }),
            parts: [{
                id: 'p1', sessionID: s, messageID: a,
                type: 'tool', callID: 'call_q', tool: 'AskUserQuestion',
                state: {
                    status: 'completed',
                    input: { question: 'Which test framework?' },
                    output: 'User chose: Vitest',
                    title: 'AskUserQuestion', metadata: {},
                    time: { start: 1000, end: 2500 },
                    block: {
                        type: 'question', id: 'q_1',
                        questions: [{ question: 'Which test framework?', header: 'Framework', options: [] }],
                        answers: [['Vitest']],
                        decidedAt: 2000,
                    },
                },
            }],
        });
        if (answeredMsgs[0].kind === 'tool-call') {
            expect(answeredMsgs[0].tool.state).toBe('completed');
            expect(answeredMsgs[0].tool.permission?.status).toBe('approved');
        }
    });

    // ── INTERRUPTION ────────────────────────────────────────────

    it('step 10: cancelled tool stays running', () => {
        const msgs = convert({
            info: asstInfo({ finish: 'cancelled' }),
            parts: [{
                id: 'p1', sessionID: s, messageID: a,
                type: 'tool', callID: 'call_cancel', tool: 'bash',
                state: {
                    status: 'running',
                    input: { command: 'sleep 100' },
                    title: 'Run `sleep 100`',
                    time: { start: 1000 },
                },
            }],
        });
        if (msgs[0].kind === 'tool-call') {
            expect(msgs[0].tool.state).toBe('running');
        }
    });

    // ── LEGACY DETECTION ────────────────────────────────────────

    it('isV3Envelope distinguishes v3 from all legacy formats', () => {
        // v3
        expect(isV3Envelope({ v: 3, message: { info: { role: 'user' }, parts: [] } })).toBe(true);

        // Legacy user
        expect(isV3Envelope({ role: 'user', content: { type: 'text', text: 'hi' } })).toBe(false);
        // Legacy agent
        expect(isV3Envelope({ role: 'agent', content: { type: 'output' } })).toBe(false);
        // Legacy session envelope
        expect(isV3Envelope({ role: 'session', content: { ev: { t: 'text' } } })).toBe(false);
        // Legacy codex
        expect(isV3Envelope({ role: 'agent', content: { type: 'codex', data: {} } })).toBe(false);
        // Legacy ACP
        expect(isV3Envelope({ role: 'agent', content: { type: 'acp', provider: 'claude' } })).toBe(false);
        // Legacy event
        expect(isV3Envelope({ role: 'agent', content: { type: 'event', data: {} } })).toBe(false);
        // Null/undefined
        expect(isV3Envelope(null)).toBe(false);
        expect(isV3Envelope(undefined)).toBe(false);
        expect(isV3Envelope(42)).toBe(false);
    });

    // ── PERSISTENCE ─────────────────────────────────────────────

    it('step 18: permission decisions survive JSON round trip', () => {
        const original = {
            info: asstInfo({ finish: 'tool-calls' }),
            parts: [{
                id: 'p1', sessionID: s, messageID: a,
                type: 'tool', callID: 'call_persist', tool: 'writeFile',
                state: {
                    status: 'completed',
                    input: { path: 'test.txt' },
                    output: 'Created',
                    title: 'writeFile', metadata: {},
                    time: { start: 1000, end: 2000 },
                    block: {
                        type: 'permission', id: 'per_persist', permission: 'edit',
                        patterns: ['test.txt'], always: ['*'],
                        metadata: { filepath: 'test.txt' },
                        decision: 'once', decidedAt: 1500,
                    },
                },
            }],
        };

        // Simulate encrypt → server → decrypt (JSON round trip)
        const serialized = JSON.stringify(original);
        const deserialized = JSON.parse(serialized);

        const msgs = convert(deserialized);
        if (msgs[0].kind === 'tool-call') {
            expect(msgs[0].tool.permission?.status).toBe('approved');
            expect(msgs[0].tool.permission?.decision).toBe('approved');
            expect(msgs[0].tool.permission?.date).toBe(1500);
        }
    });
});
