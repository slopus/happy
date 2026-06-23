import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createId, isCuid } from '@paralleldrive/cuid2';
import {
    closeClaudeTurnWithStatus,
    mapClaudeLogMessageToSessionEnvelopes,
} from './sessionProtocolMapper';

describe('mapClaudeLogMessageToSessionEnvelopes', () => {
    it('maps user text to a user text envelope', () => {
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'user',
            uuid: 'u-1',
            message: {
                role: 'user',
                content: 'hello from user',
            },
            timestamp: '2025-01-01T00:00:00.000Z',
        } as any, { currentTurnId: null });

        expect(result.currentTurnId).toBeNull();
        expect(result.envelopes).toHaveLength(1);
        expect(result.envelopes[0].role).toBe('user');
        expect(result.envelopes[0].ev).toEqual({ t: 'text', text: 'hello from user' });
    });

    it('maps non-tool user array text to user text without opening an agent turn', () => {
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'user',
            uuid: 'u-array-1',
            isSidechain: false,
            message: {
                role: 'user',
                content: [
                    { type: 'text', text: 'look at this image' },
                    {
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: 'image/png',
                            data: 'iVBORw0KGgo=',
                        },
                    },
                ],
            },
            timestamp: '2025-01-01T00:00:00.000Z',
        } as any, { currentTurnId: null });

        expect(result.currentTurnId).toBeNull();
        expect(result.envelopes).toHaveLength(1);
        expect(result.envelopes[0].role).toBe('user');
        expect(result.envelopes[0].turn).toBeUndefined();
        expect(result.envelopes[0].ev).toEqual({ t: 'text', text: 'look at this image' });
    });

    it('starts a turn and maps assistant text blocks', () => {
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-1',
            message: {
                role: 'assistant',
                content: [
                    { type: 'text', text: 'working...' },
                    { type: 'thinking', thinking: 'internal' },
                ],
            },
            timestamp: '2025-01-01T00:00:01.000Z',
        } as any, { currentTurnId: null });

        expect(result.currentTurnId).not.toBeNull();
        expect(result.envelopes).toHaveLength(3);
        expect(result.envelopes[0].ev.t).toBe('turn-start');
        expect(result.envelopes[1].ev).toEqual({ t: 'text', text: 'working...' });
        expect(result.envelopes[2].ev).toEqual({ t: 'text', text: 'internal', thinking: true });
    });

    it('maps tool use and tool result blocks to tool-call lifecycle', () => {
        const started = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-2',
            message: {
                role: 'assistant',
                content: [
                    { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
                ],
            },
        } as any, { currentTurnId: null });

        expect(started.envelopes.some((e) => e.ev.t === 'tool-call-start')).toBe(true);

        const ended = mapClaudeLogMessageToSessionEnvelopes({
            type: 'user',
            uuid: 'u-2',
            message: {
                role: 'user',
                content: [
                    { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' },
                ],
            },
        } as any, { currentTurnId: started.currentTurnId });

        expect(ended.currentTurnId).toBe(started.currentTurnId);
        expect(ended.envelopes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    ev: { t: 'tool-call-end', call: 'tool-1' },
                }),
            ]),
        );
    });

    it('exposes the generated session subagent id on Agent tool calls', () => {
        const started = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-agent-1',
            message: {
                role: 'assistant',
                content: [
                    {
                        type: 'tool_use',
                        id: 'tool-agent-1',
                        name: 'Agent',
                        input: {
                            description: 'Inspect translations',
                            prompt: 'Review all translation files',
                            mode: 'auto',
                        },
                    },
                ],
            },
        } as any, { currentTurnId: null });

        const toolCall = started.envelopes.find((envelope) => {
            return envelope.ev.t === 'tool-call-start'
                && envelope.ev.call === 'tool-agent-1';
        });

        expect(toolCall).toBeDefined();
        expect(toolCall?.ev).toEqual(expect.objectContaining({
            t: 'tool-call-start',
            name: 'Agent',
            title: 'Inspect translations',
            description: 'Inspect translations',
            args: expect.objectContaining({
                description: 'Inspect translations',
                prompt: 'Review all translation files',
                mode: 'auto',
                sessionSubagent: expect.any(String),
            }),
        }));

        if (toolCall?.ev.t === 'tool-call-start') {
            expect(isCuid(String(toolCall.ev.args.sessionSubagent))).toBe(true);
        }
    });

    it('generates stable session subagent ids for the same provider tool id', () => {
        const first = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-agent-stable-1',
            message: {
                role: 'assistant',
                content: [{
                    type: 'tool_use',
                    id: 'tool-agent-stable',
                    name: 'Agent',
                    input: {
                        description: 'Inspect translations',
                        prompt: 'Review all translation files',
                    },
                }],
            },
        } as any, { currentTurnId: null });
        const second = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-agent-stable-2',
            message: {
                role: 'assistant',
                content: [{
                    type: 'tool_use',
                    id: 'tool-agent-stable',
                    name: 'Agent',
                    input: {
                        description: 'Inspect translations',
                        prompt: 'Review all translation files',
                    },
                }],
            },
        } as any, { currentTurnId: null });

        const firstToolCall = first.envelopes.find((envelope) => envelope.ev.t === 'tool-call-start');
        const secondToolCall = second.envelopes.find((envelope) => envelope.ev.t === 'tool-call-start');

        expect(firstToolCall?.ev.t).toBe('tool-call-start');
        expect(secondToolCall?.ev.t).toBe('tool-call-start');
        if (firstToolCall?.ev.t === 'tool-call-start' && secondToolCall?.ev.t === 'tool-call-start') {
            expect(firstToolCall.ev.args.sessionSubagent).toBe(secondToolCall.ev.args.sessionSubagent);
            expect(isCuid(String(firstToolCall.ev.args.sessionSubagent))).toBe(true);
        }
    });

    it('stops visible Agent sidechains when the parent tool result arrives', () => {
        const state = { currentTurnId: null };
        const started = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-agent-stop-1',
            message: {
                role: 'assistant',
                content: [{
                    type: 'tool_use',
                    id: 'tool-agent-stop',
                    name: 'Agent',
                    input: {
                        description: 'Inspect translations',
                        prompt: 'Review all translation files',
                    },
                }],
            },
        } as any, state);
        const toolCall = started.envelopes.find((envelope) => envelope.ev.t === 'tool-call-start');
        expect(toolCall?.ev.t).toBe('tool-call-start');
        const sessionSubagent = toolCall?.ev.t === 'tool-call-start'
            ? String(toolCall.ev.args.sessionSubagent)
            : undefined;

        const child = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-agent-stop-child',
            parent_tool_use_id: 'tool-agent-stop',
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'child result' }],
            },
        } as any, state);
        expect(child.envelopes.some((envelope) => {
            return envelope.ev.t === 'start' && envelope.subagent === sessionSubagent;
        })).toBe(true);

        const stopped = mapClaudeLogMessageToSessionEnvelopes({
            type: 'user',
            uuid: 'u-agent-stop-1',
            isSidechain: false,
            message: {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'tool-agent-stop', content: 'done' }],
            },
        } as any, state);

        expect(stopped.envelopes).toEqual(expect.arrayContaining([
            expect.objectContaining({
                subagent: sessionSubagent,
                ev: { t: 'stop' },
            }),
            expect.objectContaining({
                ev: { t: 'tool-call-end', call: 'tool-agent-stop' },
            }),
        ]));
    });

    it('uses parent_tool_use_id as subagent and emits subagent start', () => {
        const mappedSubagent = createId();
        const state = {
            currentTurnId: 'turn-1',
            providerSubagentToSessionSubagent: new Map<string, string>([['task-1', mappedSubagent]]),
        };

        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-side-1',
            parent_tool_use_id: 'task-1',
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'sidechain text' }],
            },
        } as any, state);

        expect(result.envelopes).toHaveLength(2);
        expect(result.envelopes[0].subagent).toBe(mappedSubagent);
        expect(result.envelopes[0].ev).toEqual({ t: 'start' });
        expect(result.envelopes[1].subagent).toBe(mappedSubagent);
        expect(result.envelopes[1].ev).toEqual({ t: 'text', text: 'sidechain text' });
    });

    it('buffers subagent messages until parent Task registration is known', () => {
        const state = { currentTurnId: null };

        const buffered = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-side-buffered-1',
            parent_tool_use_id: 'task-buffer-1',
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'buffer me' }],
            },
        } as any, state);
        expect(buffered.envelopes).toHaveLength(0);

        const parent = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-parent-buffered-1',
            message: {
                role: 'assistant',
                content: [{
                    type: 'tool_use',
                    id: 'task-buffer-1',
                    name: 'Task',
                    input: { prompt: 'run side task' },
                }],
            },
        } as any, state);

        expect(parent.envelopes.some((envelope) => {
            return envelope.ev.t === 'tool-call-start'
                && envelope.ev.call === 'task-buffer-1';
        })).toBe(false);
        const bufferedText = parent.envelopes.find((envelope) => {
            return envelope.ev.t === 'text'
                && envelope.ev.text === 'buffer me';
        });
        expect(bufferedText?.subagent).toBeDefined();
        expect(isCuid(bufferedText!.subagent!)).toBe(true);
        expect(bufferedText?.subagent).not.toBe('task-buffer-1');
    });

    it('creates and tags subagent chain from Task prompt when parent_tool_use_id is absent', () => {
        const state = { currentTurnId: null };
        const prompt = 'Search for TypeScript 5.6 features';

        const taskToolUse = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'task-parent-assistant',
            message: {
                role: 'assistant',
                content: [{
                    type: 'tool_use',
                    id: 'task-call-1',
                    name: 'Task',
                    input: {
                        prompt,
                        description: 'Search TypeScript docs',
                    },
                }],
            },
        } as any, state);

        expect(taskToolUse.envelopes.some((envelope) => {
            return envelope.ev.t === 'tool-call-start'
                && envelope.ev.call === 'task-call-1';
        })).toBe(false);

        const sidechainRoot = mapClaudeLogMessageToSessionEnvelopes({
            type: 'user',
            uuid: 'sidechain-root',
            isSidechain: true,
            parentUuid: null,
            message: {
                role: 'user',
                content: prompt,
            },
        } as any, state);

        expect(sidechainRoot.envelopes).toHaveLength(2);
        const mappedSubagent = sidechainRoot.envelopes[0].subagent;
        expect(mappedSubagent).toBeDefined();
        expect(isCuid(mappedSubagent!)).toBe(true);
        expect(mappedSubagent).not.toBe('task-call-1');
        expect(sidechainRoot.envelopes[0].role).toBe('agent');
        expect(sidechainRoot.envelopes[0].subagent).toBe(mappedSubagent);
        expect(sidechainRoot.envelopes[0].ev).toEqual({ t: 'start', title: 'Search TypeScript docs' });
        expect(sidechainRoot.envelopes[1].subagent).toBe(mappedSubagent);
        expect(sidechainRoot.envelopes[1].ev).toEqual({ t: 'text', text: prompt });

        const sidechainChild = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'sidechain-child',
            isSidechain: true,
            parentUuid: 'sidechain-root',
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'Subagent result' }],
            },
        } as any, state);

        expect(sidechainChild.envelopes).toHaveLength(1);
        expect(sidechainChild.envelopes[0].subagent).toBe(mappedSubagent);
        expect(sidechainChild.envelopes[0].ev).toEqual({ t: 'text', text: 'Subagent result' });
    });

    it('infers subagent for non-SDK sidechain fixture logs', () => {
        const fixturePath = join(__dirname, '__fixtures__', 'task_non_sdk.jsonl');
        const rows = readFileSync(fixturePath, 'utf8')
            .trim()
            .split('\n')
            .slice(0, 6)
            .map((line) => JSON.parse(line));

        const state = { currentTurnId: null };
        const envelopes = rows.flatMap((row) => {
            return mapClaudeLogMessageToSessionEnvelopes(row as any, state).envelopes;
        });

        const subagentRoot = envelopes.find((envelope) => {
            return envelope.ev.t === 'text'
                && envelope.ev.text.startsWith('Search the web for information about TypeScript 5.6');
        });
        expect(subagentRoot?.subagent).toBeDefined();
        expect(isCuid(subagentRoot!.subagent!)).toBe(true);
        expect(subagentRoot?.subagent).not.toBe('toolu_01EmKA8FJ7B2Ah9seGxK1Wct');

        const subagentChild = envelopes.find((envelope) => {
            return envelope.ev.t === 'text'
                && envelope.ev.text.includes("I'll search for information about TypeScript 5.6");
        });
        expect(subagentChild?.subagent).toBe(subagentRoot?.subagent);
    });

    it('emits stop for completed subagent when parent Task tool returns', () => {
        const mappedSubagent = createId();
        const state = {
            currentTurnId: 'turn-1',
            providerSubagentToSessionSubagent: new Map<string, string>([['task-2', mappedSubagent]]),
            hiddenParentToolCalls: new Set<string>(['task-2']),
        };

        const started = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-side-2',
            parent_tool_use_id: 'task-2',
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'subagent running' }],
            },
        } as any, state);

        expect(started.envelopes.some((envelope) => {
            return envelope.ev.t === 'start' && envelope.subagent === mappedSubagent;
        })).toBe(true);

        const stopped = mapClaudeLogMessageToSessionEnvelopes({
            type: 'user',
            uuid: 'u-parent-2',
            isSidechain: false,
            message: {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: 'task-2', content: 'done' }],
            },
        } as any, state);

        expect(stopped.envelopes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    subagent: mappedSubagent,
                    ev: { t: 'stop' },
                }),
            ]),
        );
        expect(stopped.envelopes.some((envelope) => {
            return envelope.ev.t === 'tool-call-end'
                && envelope.ev.call === 'task-2';
        })).toBe(false);
    });

    it('does not emit envelopes for summary messages', () => {
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'summary',
            summary: 'Done',
            leafUuid: 'leaf-1',
        } as any, { currentTurnId: 'turn-1' });

        expect(result.currentTurnId).toBe('turn-1');
        expect(result.envelopes).toHaveLength(0);
    });

    it('does not emit envelopes for compact summary assistant messages', () => {
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'compact-summary-1',
            isCompactSummary: true,
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'Long compaction summary' }],
            },
        } as any, { currentTurnId: 'turn-1' });

        expect(result.currentTurnId).toBe('turn-1');
        expect(result.envelopes).toHaveLength(0);
    });
});

describe('closeClaudeTurnWithStatus', () => {
    it('emits turn-end with provided status when turn is active', () => {
        const result = closeClaudeTurnWithStatus({ currentTurnId: 'turn-1' }, 'cancelled');
        expect(result.currentTurnId).toBeNull();
        expect(result.envelopes).toHaveLength(1);
        expect(result.envelopes[0].ev).toEqual({ t: 'turn-end', status: 'cancelled' });
    });

    it('stops active subagents before ending an aborted turn', () => {
        const subagent = createId();
        const result = closeClaudeTurnWithStatus({
            currentTurnId: 'turn-1',
            startedSubagents: new Set([subagent]),
            activeSubagents: new Set([subagent]),
        }, 'cancelled');

        expect(result.currentTurnId).toBeNull();
        expect(result.envelopes).toHaveLength(2);
        expect(result.envelopes[0]).toMatchObject({
            subagent,
            ev: { t: 'stop' },
        });
        expect(result.envelopes[1].ev).toEqual({ t: 'turn-end', status: 'cancelled' });
    });
});
