import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createId, isCuid } from '@paralleldrive/cuid2';
import {
    closeClaudeTurnWithStatus,
    mapClaudeLogMessageToSessionEnvelopes,
} from './sessionProtocolMapper';
import { SDKToLogConverter } from './sdkToLogConverter';

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

    // specs/midturn-task-notification-sync R2 — 스캐너가 승격한 턴 중 알림은 진행 중인
    // 턴의 일부다. 일반 user 행처럼 closeTurn 하면 살아 있는 턴이 중간에 끝난 것으로
    // 기록돼 클라이언트가 조기 turn-end 를 관찰한다.
    it('does not close the active turn for a promoted mid-turn task notification', () => {
        const state = { currentTurnId: 'turn-live' } as any;
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'user',
            uuid: 'att-notif-1',
            isSidechain: false,
            happyTaskNotification: true,
            message: {
                role: 'user',
                content: '<task-notification>\n<tool-use-id>toolu_01x</tool-use-id>\n<status>completed</status>\n</task-notification>',
            },
        } as any, state);

        expect(result.currentTurnId).toBe('turn-live');
        expect(result.envelopes).toHaveLength(1);
        expect(result.envelopes[0].role).toBe('user');
        expect(result.envelopes[0].ev.t).toBe('text');
        expect(result.envelopes.some((e: any) => e.ev?.t === 'turn-end')).toBe(false);
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

    it('carries base64 image blocks from a tool_result inline on tool-call-end', () => {
        // specs/20260815-chat-tool-result-image-render — Read on an image
        // returns a tool_result whose content holds a base64 image block.
        mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-img-1',
            message: {
                role: 'assistant',
                content: [
                    { type: 'tool_use', id: 'tool-img-1', name: 'Read', input: { file_path: '/tmp/a.png' } },
                ],
            },
        } as any, { currentTurnId: null });

        const started = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-img-1',
            message: {
                role: 'assistant',
                content: [
                    { type: 'tool_use', id: 'tool-img-1', name: 'Read', input: { file_path: '/tmp/a.png' } },
                ],
            },
        } as any, { currentTurnId: null });

        const ended = mapClaudeLogMessageToSessionEnvelopes({
            type: 'user',
            uuid: 'u-img-1',
            message: {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: 'tool-img-1',
                        content: [
                            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
                        ],
                    },
                ],
            },
        } as any, { currentTurnId: started.currentTurnId });

        expect(ended.envelopes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    ev: {
                        t: 'tool-call-end',
                        call: 'tool-img-1',
                        images: [{ mediaType: 'image/png', data: 'AAA' }],
                    },
                }),
            ]),
        );
    });

    it('omits images when the tool_result content has none', () => {
        const started = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-noimg-1',
            message: {
                role: 'assistant',
                content: [
                    { type: 'tool_use', id: 'tool-noimg-1', name: 'Bash', input: { command: 'ls' } },
                ],
            },
        } as any, { currentTurnId: null });

        const ended = mapClaudeLogMessageToSessionEnvelopes({
            type: 'user',
            uuid: 'u-noimg-1',
            message: {
                role: 'user',
                content: [
                    { type: 'tool_result', tool_use_id: 'tool-noimg-1', content: 'ok' },
                ],
            },
        } as any, { currentTurnId: started.currentTurnId });

        expect(ended.envelopes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ ev: { t: 'tool-call-end', call: 'tool-noimg-1' } }),
            ]),
        );
    });

    // specs/agent-activity-indicator Phase 22 — the background task id lives
    // only in the launch's tool_result text. Without it the web indicator
    // cannot tell which launch a TaskStop / previous-session cleanup refers
    // to, so a stopped task stays "running" forever.
    it('rides the background task id of a background shell launch on tool-call-end', () => {
        const started = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-bg-1',
            message: {
                role: 'assistant',
                content: [
                    { type: 'tool_use', id: 'tool-bg-1', name: 'Bash', input: { command: 'sleep 180', run_in_background: true } },
                ],
            },
        } as any, { currentTurnId: null });

        const ended = mapClaudeLogMessageToSessionEnvelopes({
            type: 'user',
            uuid: 'u-bg-1',
            message: {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: 'tool-bg-1',
                        content: 'Command running in background with ID: b59ok9s5w. Output is being written to: /tmp/tasks/b59ok9s5w.output.',
                    },
                ],
            },
        } as any, { currentTurnId: started.currentTurnId });

        expect(ended.envelopes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    ev: { t: 'tool-call-end', call: 'tool-bg-1', backgroundTaskId: 'b59ok9s5w' },
                }),
            ]),
        );
    });

    it('rides the background task id of a background agent launch on tool-call-end', () => {
        const started = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-bga-1',
            message: {
                role: 'assistant',
                content: [
                    { type: 'tool_use', id: 'tool-bga-1', name: 'Agent', input: { description: '검토', run_in_background: true } },
                ],
            },
        } as any, { currentTurnId: null });

        const ended = mapClaudeLogMessageToSessionEnvelopes({
            type: 'user',
            uuid: 'u-bga-1',
            message: {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: 'tool-bga-1',
                        content: [
                            { type: 'text', text: 'Async agent launched successfully.\nagentId: a1958ec940e6b45bf (internal ID - do not mention)' },
                        ],
                    },
                ],
            },
        } as any, { currentTurnId: started.currentTurnId });

        expect(ended.envelopes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    ev: { t: 'tool-call-end', call: 'tool-bga-1', backgroundTaskId: 'a1958ec940e6b45bf' },
                }),
            ]),
        );
    });

    it('omits the background task id for an ordinary foreground result', () => {
        const started = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-fg-1',
            message: {
                role: 'assistant',
                content: [
                    { type: 'tool_use', id: 'tool-fg-1', name: 'Bash', input: { command: 'ls' } },
                ],
            },
        } as any, { currentTurnId: null });

        const ended = mapClaudeLogMessageToSessionEnvelopes({
            type: 'user',
            uuid: 'u-fg-1',
            message: {
                role: 'user',
                content: [
                    { type: 'tool_result', tool_use_id: 'tool-fg-1', content: 'a.txt\nb.txt' },
                ],
            },
        } as any, { currentTurnId: started.currentTurnId });

        expect(ended.envelopes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ ev: { t: 'tool-call-end', call: 'tool-fg-1' } }),
            ]),
        );
    });

    it('drops images from a tool whose name matches the redact policy', () => {
        // The MCP prefix policy already redacts text for these tools
        // (redactGate.ts); images from the same tools must not leak either.
        const started = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'a-redact-1',
            message: {
                role: 'assistant',
                content: [
                    { type: 'tool_use', id: 'tool-redact-1', name: 'mcp__aplus-common__inspect_org_repository', input: {} },
                ],
            },
        } as any, { currentTurnId: null });

        const ended = mapClaudeLogMessageToSessionEnvelopes({
            type: 'user',
            uuid: 'u-redact-1',
            message: {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: 'tool-redact-1',
                        content: [
                            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
                        ],
                    },
                ],
            },
        } as any, { currentTurnId: started.currentTurnId });

        expect(ended.envelopes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ ev: { t: 'tool-call-end', call: 'tool-redact-1' } }),
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
});

describe('channel request correlation on turn boundaries', () => {
    // Saycode specs/desktop-messenger-channels. The handle rides the turn boundary because that
    // is what identifies *which* work a reply belongs to; "the last assistant message" and
    // "afterSeq" are both wrong as soon as another turn is in flight.
    const assistantText = {
        type: 'assistant',
        uuid: 'a-1',
        message: { role: 'assistant', model: 'claude', content: [{ type: 'text', text: 'working' }] },
        timestamp: '2025-01-01T00:00:00.000Z',
    } as any;

    it('stamps the pending request id on the turn it opens', () => {
        const state = { currentTurnId: null, pendingRequestId: 'core-req-1' };
        const result = mapClaudeLogMessageToSessionEnvelopes(assistantText, state);

        const start = result.envelopes.find((envelope) => (envelope.ev as { t: string }).t === 'turn-start');
        expect(start?.ev).toMatchObject({ t: 'turn-start', requestId: 'core-req-1' });
        // Consumed, so it cannot be inherited by whatever opens next.
        expect(state.pendingRequestId).toBeNull();
    });

    it('repeats the same id on the matching turn-end', () => {
        const state = { currentTurnId: null, pendingRequestId: 'core-req-1' };
        mapClaudeLogMessageToSessionEnvelopes(assistantText, state);
        const closed = closeClaudeTurnWithStatus(state, 'completed');

        expect(closed.envelopes[0].ev).toMatchObject({
            t: 'turn-end', status: 'completed', requestId: 'core-req-1',
        });
    });

    it('carries the terminal status, so a cancelled turn is not read as an answer', () => {
        const state = { currentTurnId: null, pendingRequestId: 'core-req-2' };
        mapClaudeLogMessageToSessionEnvelopes(assistantText, state);
        const closed = closeClaudeTurnWithStatus(state, 'cancelled');

        expect(closed.envelopes[0].ev).toMatchObject({
            t: 'turn-end', status: 'cancelled', requestId: 'core-req-2',
        });
    });

    it('leaves an ordinary in-app turn with no request id at all', () => {
        const state = { currentTurnId: null };
        const result = mapClaudeLogMessageToSessionEnvelopes(assistantText, state);
        const start = result.envelopes.find((envelope) => (envelope.ev as { t: string }).t === 'turn-start');

        expect(start?.ev).toEqual({ t: 'turn-start' });
        expect(closeClaudeTurnWithStatus(state, 'completed').envelopes[0].ev)
            .toEqual({ t: 'turn-end', status: 'completed' });
    });

    it('does not let a later turn inherit a consumed id', () => {
        const state = { currentTurnId: null, pendingRequestId: 'core-req-3' };
        mapClaudeLogMessageToSessionEnvelopes(assistantText, state);
        closeClaudeTurnWithStatus(state, 'completed');

        // A second, unrelated turn opens with nothing pending.
        const second = mapClaudeLogMessageToSessionEnvelopes({ ...assistantText, uuid: 'a-2' }, state);
        const start = second.envelopes.find((envelope) => (envelope.ev as { t: string }).t === 'turn-start');
        expect(start?.ev).toEqual({ t: 'turn-start' });
    });
})

describe('channel correlation on runs that produce no text', () => {
    const assistantText = {
        type: 'assistant',
        uuid: 'a-1',
        message: { role: 'assistant', model: 'claude', content: [{ type: 'text', text: 'working' }] },
        timestamp: '2025-01-01T00:00:00.000Z',
    } as any;

    it('answers a request whose run failed before producing any text', () => {
        // A turn only opens on mapped activity. Without this the pending id is stranded: the
        // caller waits forever, and the next unrelated turn inherits the id.
        const state = { currentTurnId: null, pendingRequestId: 'core-req-1' };
        const closed = closeClaudeTurnWithStatus(state, 'failed');

        expect(closed.envelopes.map((envelope) => (envelope.ev as { t: string }).t))
            .toEqual(['turn-start', 'turn-end']);
        expect(closed.envelopes[0].ev).toMatchObject({ requestId: 'core-req-1' });
        expect(closed.envelopes[1].ev).toMatchObject({ status: 'failed', requestId: 'core-req-1' });
        expect(state.pendingRequestId).toBeNull();
    });

    it('stays silent for an in-app run that produced nothing', () => {
        const state = { currentTurnId: null };
        expect(closeClaudeTurnWithStatus(state, 'completed').envelopes).toHaveLength(0);
    });

    it('never bleeds a channel id into the next ordinary turn', () => {
        // Channel request A, then an ordinary Desktop turn B, across each path that can end a
        // turn: a clean close, an empty terminal result, and a cancel.
        for (const status of ['completed', 'failed', 'cancelled'] as const) {
            const state = { currentTurnId: null, pendingRequestId: 'core-req-A' };
            mapClaudeLogMessageToSessionEnvelopes(assistantText, state);
            closeClaudeTurnWithStatus(state, status);

            const ordinary = mapClaudeLogMessageToSessionEnvelopes({ ...assistantText, uuid: 'b-1' }, state);
            const start = ordinary.envelopes.find((envelope) => (envelope.ev as { t: string }).t === 'turn-start');
            expect(start?.ev).toEqual({ t: 'turn-start' });
            expect(closeClaudeTurnWithStatus(state, 'completed').envelopes[0].ev)
                .toEqual({ t: 'turn-end', status: 'completed' });
        }
    });

    it('does not bleed after a textless terminal result either', () => {
        const state = { currentTurnId: null, pendingRequestId: 'core-req-A' };
        closeClaudeTurnWithStatus(state, 'failed');

        const ordinary = mapClaudeLogMessageToSessionEnvelopes({ ...assistantText, uuid: 'b-2' }, state);
        const start = ordinary.envelopes.find((envelope) => (envelope.ev as { t: string }).t === 'turn-start');
        expect(start?.ev).toEqual({ t: 'turn-start' });
    });

    it('reuses the channel request for the turn after a background task notification', () => {
        const state = { currentTurnId: null, pendingRequestId: 'core-req-bg' };
        mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'bg-assistant',
            message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'tool-bg', name: 'Agent', input: { run_in_background: true } }],
            },
        } as any, state);
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'user',
            uuid: 'bg-result',
            message: {
                role: 'user',
                content: [{
                    type: 'tool_result',
                    tool_use_id: 'tool-bg',
                    content: 'Async agent launched successfully.\nagentId: task-bg-1',
                }],
            },
        } as any, state);
        expect(result.envelopes).toEqual(expect.arrayContaining([
            expect.objectContaining({ ev: { t: 'tool-call-end', call: 'tool-bg', backgroundTaskId: 'task-bg-1' } }),
        ]));
        closeClaudeTurnWithStatus(state, 'completed');

        mapClaudeLogMessageToSessionEnvelopes({
            type: 'user',
            uuid: 'bg-notification',
            happyTaskNotification: true,
            message: {
                role: 'user',
                content: '<task-notification>\n<task-id>task-bg-1</task-id>\n<tool-use-id>tool-bg</tool-use-id>\n<status>completed</status>\n</task-notification>',
            },
        } as any, state);
        const resumed = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant',
            uuid: 'bg-follow-up',
            message: { role: 'assistant', content: [{ type: 'text', text: 'background work is complete' }] },
        } as any, state);
        expect(resumed.envelopes.find((item) => item.ev.t === 'turn-start')?.ev)
            .toMatchObject({ t: 'turn-start', requestId: 'core-req-bg' });
    });

    it('correlates a hidden Task launch before dropping its parent tool envelope', () => {
        const state = { currentTurnId: null, pendingRequestId: 'core-req-task' };
        mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant', uuid: 'task-assistant',
            message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-task', name: 'Task', input: { run_in_background: true } }] },
        } as any, state);
        const result = mapClaudeLogMessageToSessionEnvelopes({
            type: 'user', uuid: 'task-result',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-task', content: 'Async agent launched successfully.\nagentId: task-hidden-1' }] },
        } as any, state);
        expect(result.envelopes.some((item) => item.ev.t === 'tool-call-end')).toBe(false);
        closeClaudeTurnWithStatus(state, 'completed');
        mapClaudeLogMessageToSessionEnvelopes({
            type: 'user', uuid: 'task-notification', happyTaskNotification: true,
            message: { role: 'user', content: '<task-notification><task-id>task-hidden-1</task-id></task-notification>' },
        } as any, state);
        const resumed = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant', uuid: 'task-follow-up',
            message: { role: 'assistant', content: [{ type: 'text', text: 'hidden task complete' }] },
        } as any, state);
        expect(resumed.envelopes.find((item) => item.ev.t === 'turn-start')?.ev)
            .toMatchObject({ t: 'turn-start', requestId: 'core-req-task' });
    });

    it('does not attach an unrelated task notification to an ordinary turn', () => {
        const state = { currentTurnId: null };
        mapClaudeLogMessageToSessionEnvelopes({
            type: 'user', uuid: 'unknown-notification', happyTaskNotification: true,
            message: { role: 'user', content: '<task-notification><task-id>unknown</task-id></task-notification>' },
        } as any, state);
        const resumed = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant', uuid: 'ordinary-follow-up',
            message: { role: 'assistant', content: [{ type: 'text', text: 'ordinary' }] },
        } as any, state);
        expect(resumed.envelopes.find((item) => item.ev.t === 'turn-start')?.ev).toEqual({ t: 'turn-start' });
    });

    // Claude Code consumes a notification that arrives while idle as a plain `user` row (string
    // content, `origin.kind: task-notification`) — no attachment row, so no scanner marker. The
    // SDK reports the same completion as a `system`/`task_notification` message on its own stream.
    const idleNotificationContent = '<task-notification>\n<task-id>task-idle-1</task-id>\n'
        + '<tool-use-id>tool-idle</tool-use-id>\n<status>completed</status>\n</task-notification>';
    const idleNotificationRow = {
        type: 'user',
        uuid: 'idle-notification',
        isSidechain: false,
        origin: { kind: 'task-notification', producer: 'session-task' },
        message: { role: 'user', content: idleNotificationContent },
    };
    const launchBackgroundTaskAndClose = (requestId: string) => {
        const state = { currentTurnId: null, pendingRequestId: requestId };
        mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant', uuid: 'idle-launch',
            message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-idle', name: 'Agent', input: { run_in_background: true } }] },
        } as any, state);
        mapClaudeLogMessageToSessionEnvelopes({
            type: 'user', uuid: 'idle-launch-result',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-idle', content: 'Async agent launched successfully.\nagentId: task-idle-1' }] },
        } as any, state);
        closeClaudeTurnWithStatus(state, 'completed');
        return state;
    };
    const followUpTurnStart = (state: Parameters<typeof mapClaudeLogMessageToSessionEnvelopes>[1]) => {
        const resumed = mapClaudeLogMessageToSessionEnvelopes({
            type: 'assistant', uuid: 'idle-follow-up',
            message: { role: 'assistant', content: [{ type: 'text', text: 'background work is complete' }] },
        } as any, state);
        return resumed.envelopes.find((item) => item.ev.t === 'turn-start')?.ev;
    };

    it('reuses the channel request when the SDK reports an idle background task notification', () => {
        const state = launchBackgroundTaskAndClose('core-req-idle-sdk');
        const converter = new SDKToLogConverter({ sessionId: 'session-idle', cwd: process.cwd(), gitBranch: 'main', version: 'test' });
        const notification = converter.convert({
            type: 'system',
            subtype: 'task_notification',
            task_id: 'task-idle-1',
            tool_use_id: 'tool-idle',
            status: 'completed',
            output_file: '/tmp/task-idle-1.output',
            summary: 'Agent finished',
            uuid: 'sdk-idle-notification',
            session_id: 'session-idle',
        } as any);
        mapClaudeLogMessageToSessionEnvelopes(notification as any, state);

        expect(followUpTurnStart(state)).toEqual({ t: 'turn-start', requestId: 'core-req-idle-sdk' });
    });

    it('reuses the channel request from an idle task notification row', () => {
        const state = launchBackgroundTaskAndClose('core-req-idle-row');
        mapClaudeLogMessageToSessionEnvelopes(idleNotificationRow as any, state);

        expect(followUpTurnStart(state)).toEqual({ t: 'turn-start', requestId: 'core-req-idle-row' });
    });

    it('keeps the re-armed request when the idle row follows the SDK notification', () => {
        const state = launchBackgroundTaskAndClose('core-req-idle-both');
        mapClaudeLogMessageToSessionEnvelopes({
            type: 'system', subtype: 'task_notification', uuid: 'sdk-idle-both', task_id: 'task-idle-1', tool_use_id: 'tool-idle',
        } as any, state);
        const row = mapClaudeLogMessageToSessionEnvelopes(idleNotificationRow as any, state);

        // An empty turn here would answer the channel request before the provider's follow-up.
        expect(row.envelopes.map((item) => item.ev.t)).toEqual(['text']);
        expect(followUpTurnStart(state)).toEqual({ t: 'turn-start', requestId: 'core-req-idle-both' });
    });
});
