import { describe, expect, it, vi } from 'vitest';
import { createId, isCuid } from '@paralleldrive/cuid2';
import {
    mapCodexMcpMessageToSessionEnvelopes,
    mapCodexProcessorMessageToSessionEnvelopes,
    mapCodexThreadToSessionEnvelopes,
} from '../utils/sessionProtocolMapper';

describe('mapCodexMcpMessageToSessionEnvelopes', () => {
    it('starts and ends turns for task lifecycle events', () => {
        const started = mapCodexMcpMessageToSessionEnvelopes({ type: 'task_started' }, { currentTurnId: null });

        expect(started.envelopes).toHaveLength(1);
        expect(started.envelopes[0].ev.t).toBe('turn-start');
        expect(started.envelopes[0].turn).toBe(started.currentTurnId);
        expect(started.envelopes[0].turn).not.toBe(started.envelopes[0].id);

        const ended = mapCodexMcpMessageToSessionEnvelopes({ type: 'task_complete' }, { currentTurnId: started.currentTurnId });
        expect(ended.envelopes).toHaveLength(1);
        expect(ended.envelopes[0].ev.t).toBe('turn-end');
        if (ended.envelopes[0].ev.t === 'turn-end') {
            expect(ended.envelopes[0].ev.status).toBe('completed');
        }
        expect(ended.envelopes[0].turn).toBe(started.currentTurnId);
        expect(ended.currentTurnId).toBeNull();
    });

    it('maps abort lifecycle with cancelled turn-end status', () => {
        const result = mapCodexMcpMessageToSessionEnvelopes(
            { type: 'turn_aborted' },
            { currentTurnId: 'turn-1' }
        );

        expect(result.envelopes).toHaveLength(1);
        expect(result.envelopes[0].ev).toEqual({
            t: 'turn-end',
            status: 'cancelled',
        });
        expect(result.currentTurnId).toBeNull();
    });

    it('maps agent text messages with turn context', () => {
        const result = mapCodexMcpMessageToSessionEnvelopes(
            { type: 'agent_message', message: 'hello' },
            { currentTurnId: 'turn-1' }
        );

        expect(result.envelopes).toHaveLength(1);
        expect(result.envelopes[0].turn).toBe('turn-1');
        expect(result.envelopes[0].ev).toEqual({ t: 'text', text: 'hello' });
    });

    it('maps parent call linkage to subagent field', () => {
        const result = mapCodexMcpMessageToSessionEnvelopes(
            { type: 'agent_message', message: 'subagent hello', parent_call_id: 'parent-call-1' },
            { currentTurnId: 'turn-1' }
        );

        expect(result.envelopes).toHaveLength(2);
        const subagent = result.envelopes[1].subagent;
        expect(typeof subagent).toBe('string');
        expect(isCuid(subagent!)).toBe(true);
        expect(result.envelopes[0]).toMatchObject({
            subagent,
            ev: { t: 'start' },
        });
        expect(subagent).not.toBe('parent-call-1');
    });

    it('maps Codex collab-agent calls to a session subagent without leaking provider ids', () => {
        const collab = mapCodexMcpMessageToSessionEnvelopes(
            {
                type: 'collab_agent_begin',
                call_id: 'collab-1',
                tool: 'spawnAgent',
                status: 'inProgress',
                sender_thread_id: 'parent-thread',
                receiver_thread_ids: ['provider-child-thread'],
                prompt: 'Inspect auth flow',
                model: 'gpt-test',
            },
            { currentTurnId: 'turn-1' }
        );

        expect(collab.envelopes).toHaveLength(2);
        const toolCall = collab.envelopes[0];
        expect(toolCall.ev.t).toBe('tool-call-start');
        if (toolCall.ev.t === 'tool-call-start') {
            expect(toolCall.ev.name).toBe('CodexSubagent');
            expect(toolCall.ev.args.sessionSubagent).toEqual(expect.any(String));
            expect(isCuid(String(toolCall.ev.args.sessionSubagent))).toBe(true);
            expect(toolCall.ev.args.sessionSubagent).not.toBe('provider-child-thread');
            expect(toolCall.ev.args).not.toHaveProperty('senderThreadId');
            expect(toolCall.ev.args).not.toHaveProperty('receiverThreadIds');
            expect(toolCall.ev.args.sessionSubagents).toEqual([toolCall.ev.args.sessionSubagent]);
            expect(toolCall.ev.args.agentStates).toEqual([]);
        }

        const sessionSubagent = collab.envelopes[1].subagent;
        expect(sessionSubagent).toBeDefined();
        expect(isCuid(sessionSubagent!)).toBe(true);
        expect(sessionSubagent).toBe(
            toolCall.ev.t === 'tool-call-start' ? toolCall.ev.args.sessionSubagent : undefined
        );
        expect(collab.envelopes[1].ev).toEqual({ t: 'start', title: 'Inspect auth flow' });

        const child = mapCodexMcpMessageToSessionEnvelopes(
            {
                type: 'agent_message',
                message: 'found auth handler',
                agent_thread_id: 'provider-child-thread',
            },
            {
                currentTurnId: 'turn-1',
                startedSubagents: collab.startedSubagents,
                activeSubagents: collab.activeSubagents,
                providerSubagentToSessionSubagent: collab.providerSubagentToSessionSubagent,
                subagentTitles: collab.subagentTitles,
            }
        );

        expect(child.envelopes).toHaveLength(1);
        expect(child.envelopes[0].subagent).toBe(sessionSubagent);
        expect(child.envelopes[0].ev).toEqual({ t: 'text', text: 'found auth handler' });
    });

    it('keeps Codex provider subagent mapping stable across turns', () => {
        const state = { currentTurnId: null };

        const firstTurn = mapCodexMcpMessageToSessionEnvelopes({ type: 'task_started' }, state);
        Object.assign(state, {
            currentTurnId: firstTurn.currentTurnId,
            startedSubagents: firstTurn.startedSubagents,
            activeSubagents: firstTurn.activeSubagents,
            providerSubagentToSessionSubagent: firstTurn.providerSubagentToSessionSubagent,
            subagentTitles: firstTurn.subagentTitles,
            collabReceiverThreadIdsByCall: firstTurn.collabReceiverThreadIdsByCall,
            collabToolByCall: firstTurn.collabToolByCall,
        });

        const firstChild = mapCodexMcpMessageToSessionEnvelopes({
            type: 'agent_message',
            message: 'first child output',
            agent_thread_id: 'provider-child-thread',
        }, state);
        const firstSubagent = firstChild.envelopes.at(-1)?.subagent;
        expect(firstSubagent).toBeDefined();
        expect(isCuid(firstSubagent!)).toBe(true);

        const firstEnd = mapCodexMcpMessageToSessionEnvelopes({ type: 'task_complete' }, {
            ...state,
            startedSubagents: firstChild.startedSubagents,
            activeSubagents: firstChild.activeSubagents,
            providerSubagentToSessionSubagent: firstChild.providerSubagentToSessionSubagent,
            subagentTitles: firstChild.subagentTitles,
            collabReceiverThreadIdsByCall: firstChild.collabReceiverThreadIdsByCall,
            collabToolByCall: firstChild.collabToolByCall,
        });
        const secondTurn = mapCodexMcpMessageToSessionEnvelopes({ type: 'task_started' }, {
            currentTurnId: firstEnd.currentTurnId,
            startedSubagents: firstEnd.startedSubagents,
            activeSubagents: firstEnd.activeSubagents,
            providerSubagentToSessionSubagent: firstEnd.providerSubagentToSessionSubagent,
            subagentTitles: firstEnd.subagentTitles,
            collabReceiverThreadIdsByCall: firstEnd.collabReceiverThreadIdsByCall,
            collabToolByCall: firstEnd.collabToolByCall,
        });
        const secondChild = mapCodexMcpMessageToSessionEnvelopes({
            type: 'agent_message',
            message: 'second child output',
            agent_thread_id: 'provider-child-thread',
        }, {
            currentTurnId: secondTurn.currentTurnId,
            startedSubagents: secondTurn.startedSubagents,
            activeSubagents: secondTurn.activeSubagents,
            providerSubagentToSessionSubagent: secondTurn.providerSubagentToSessionSubagent,
            subagentTitles: secondTurn.subagentTitles,
            collabReceiverThreadIdsByCall: secondTurn.collabReceiverThreadIdsByCall,
            collabToolByCall: secondTurn.collabToolByCall,
        });

        expect(secondChild.envelopes.at(-1)?.subagent).toBe(firstSubagent);
    });

    it('uses remembered receiver threads when collab-agent end payload is sparse', () => {
        const spawn = mapCodexMcpMessageToSessionEnvelopes(
            {
                type: 'collab_agent_begin',
                call_id: 'spawn-1',
                tool: 'spawnAgent',
                status: 'inProgress',
                receiver_thread_ids: ['provider-child-thread'],
                prompt: 'Inspect auth flow',
            },
            { currentTurnId: 'turn-1' }
        );
        const sessionSubagent = spawn.envelopes.find((envelope) => envelope.ev.t === 'start')?.subagent;
        expect(sessionSubagent).toBeDefined();

        const closeBegin = mapCodexMcpMessageToSessionEnvelopes(
            {
                type: 'collab_agent_begin',
                call_id: 'close-1',
                tool: 'closeAgent',
                status: 'inProgress',
                receiver_thread_ids: ['provider-child-thread'],
            },
            {
                currentTurnId: 'turn-1',
                startedSubagents: spawn.startedSubagents,
                activeSubagents: spawn.activeSubagents,
                providerSubagentToSessionSubagent: spawn.providerSubagentToSessionSubagent,
                subagentTitles: spawn.subagentTitles,
                collabReceiverThreadIdsByCall: spawn.collabReceiverThreadIdsByCall,
                collabToolByCall: spawn.collabToolByCall,
            }
        );

        const closeEnd = mapCodexMcpMessageToSessionEnvelopes(
            {
                type: 'collab_agent_end',
                call_id: 'close-1',
                status: 'completed',
            },
            {
                currentTurnId: 'turn-1',
                startedSubagents: closeBegin.startedSubagents,
                activeSubagents: closeBegin.activeSubagents,
                providerSubagentToSessionSubagent: closeBegin.providerSubagentToSessionSubagent,
                subagentTitles: closeBegin.subagentTitles,
                collabReceiverThreadIdsByCall: closeBegin.collabReceiverThreadIdsByCall,
                collabToolByCall: closeBegin.collabToolByCall,
            }
        );

        expect(closeEnd.envelopes).toEqual(expect.arrayContaining([
            expect.objectContaining({
                subagent: sessionSubagent,
                ev: { t: 'stop' },
            }),
        ]));
    });

    it('maps subagent-scoped Codex reasoning into the matching sidechain', () => {
        const started = mapCodexMcpMessageToSessionEnvelopes(
            {
                type: 'subagent_activity',
                kind: 'started',
                agent_thread_id: 'provider-child-thread',
                agent_path: 'Auth explorer',
            },
            { currentTurnId: 'turn-1' }
        );
        const sessionSubagent = started.envelopes.find((envelope) => envelope.ev.t === 'start')?.subagent;

        const reasoning = mapCodexMcpMessageToSessionEnvelopes(
            {
                type: 'agent_reasoning',
                text: 'checking auth flow',
                agent_thread_id: 'provider-child-thread',
            },
            {
                currentTurnId: 'turn-1',
                startedSubagents: started.startedSubagents,
                activeSubagents: started.activeSubagents,
                providerSubagentToSessionSubagent: started.providerSubagentToSessionSubagent,
                subagentTitles: started.subagentTitles,
                collabReceiverThreadIdsByCall: started.collabReceiverThreadIdsByCall,
                collabToolByCall: started.collabToolByCall,
            }
        );

        expect(reasoning.envelopes).toHaveLength(1);
        expect(reasoning.envelopes[0]).toMatchObject({
            subagent: sessionSubagent,
            ev: { t: 'text', text: 'checking auth flow', thinking: true },
        });
    });

    it('emits sanitized visible status messages from collab-agent states', () => {
        const started = mapCodexMcpMessageToSessionEnvelopes(
            {
                type: 'collab_agent_begin',
                call_id: 'collab-1',
                tool: 'spawnAgent',
                status: 'inProgress',
                receiver_thread_ids: ['provider-child-thread'],
                prompt: 'Inspect auth flow',
            },
            { currentTurnId: 'turn-1' }
        );
        const sessionSubagent = started.envelopes.find((envelope) => envelope.ev.t === 'start')?.subagent;

        const ended = mapCodexMcpMessageToSessionEnvelopes(
            {
                type: 'collab_agent_end',
                call_id: 'collab-1',
                tool: 'spawnAgent',
                status: 'completed',
                agents_states: {
                    'provider-child-thread': { status: 'completed', message: 'found auth handler' },
                },
            },
            {
                currentTurnId: 'turn-1',
                startedSubagents: started.startedSubagents,
                activeSubagents: started.activeSubagents,
                providerSubagentToSessionSubagent: started.providerSubagentToSessionSubagent,
                subagentTitles: started.subagentTitles,
                collabReceiverThreadIdsByCall: started.collabReceiverThreadIdsByCall,
                collabToolByCall: started.collabToolByCall,
            }
        );

        const service = ended.envelopes.find((envelope) => envelope.ev.t === 'service');
        expect(service).toMatchObject({
            subagent: sessionSubagent,
            ev: { t: 'service', text: 'Codex subagent completed: found auth handler' },
        });
    });

    it('maps Codex subagent activity markers to lifecycle envelopes', () => {
        const started = mapCodexMcpMessageToSessionEnvelopes(
            {
                type: 'subagent_activity',
                kind: 'started',
                agent_thread_id: 'provider-child-thread',
                agent_path: 'Auth explorer',
            },
            { currentTurnId: 'turn-1' }
        );

        expect(started.envelopes).toHaveLength(2);
        expect(started.envelopes[0].ev).toEqual({ t: 'start', title: 'Auth explorer' });
        expect(started.envelopes[0].subagent).toBeDefined();
        expect(isCuid(started.envelopes[0].subagent!)).toBe(true);
        expect(started.envelopes[1]).toMatchObject({
            subagent: started.envelopes[0].subagent,
            ev: { t: 'service', text: 'Codex subagent started: Auth explorer' },
        });

        const interrupted = mapCodexMcpMessageToSessionEnvelopes(
            {
                type: 'subagent_activity',
                kind: 'interrupted',
                agent_thread_id: 'provider-child-thread',
            },
            {
                currentTurnId: 'turn-1',
                startedSubagents: started.startedSubagents,
                activeSubagents: started.activeSubagents,
                providerSubagentToSessionSubagent: started.providerSubagentToSessionSubagent,
                subagentTitles: started.subagentTitles,
            }
        );

        expect(interrupted.envelopes).toHaveLength(2);
        expect(interrupted.envelopes[0]).toMatchObject({
            subagent: started.envelopes[0].subagent,
            ev: { t: 'service', text: 'Codex subagent interrupted' },
        });
        expect(interrupted.envelopes[1].ev).toEqual({ t: 'stop' });
        expect(interrupted.envelopes[1].subagent).toBe(started.envelopes[0].subagent);
    });

    it('emits stop for active subagents before turn-end', () => {
        const subagent = createId();
        const activeSubagents = new Set<string>([subagent]);
        const startedSubagents = new Set<string>([subagent]);
        const result = mapCodexMcpMessageToSessionEnvelopes(
            { type: 'task_complete' },
            { currentTurnId: 'turn-1', activeSubagents, startedSubagents }
        );

        expect(result.envelopes).toHaveLength(2);
        expect(result.envelopes[0]).toMatchObject({
            subagent,
            ev: { t: 'stop' },
        });
        expect(result.envelopes[1].ev).toEqual({
            t: 'turn-end',
            status: 'completed',
        });
    });

    it('maps exec command begin to tool-call-start', () => {
        const result = mapCodexMcpMessageToSessionEnvelopes(
            {
                type: 'exec_command_begin',
                call_id: 'call-1',
                command: 'ls -la',
                cwd: '/tmp',
            },
            { currentTurnId: 'turn-1' }
        );

        expect(result.envelopes).toHaveLength(1);
        const envelope = result.envelopes[0];
        expect(envelope.ev.t).toBe('tool-call-start');
        if (envelope.ev.t === 'tool-call-start') {
            expect(envelope.ev.call).toBe('call-1');
            expect(envelope.ev.name).toBe('CodexBash');
            expect(envelope.ev.title).toContain('Run `ls -la`');
            expect(envelope.ev.args).toEqual({ command: 'ls -la', cwd: '/tmp' });
        }
    });

    it('maps token_count messages to usage-only session envelopes', () => {
        const result = mapCodexMcpMessageToSessionEnvelopes(
            { type: 'token_count', total_tokens: 10 },
            { currentTurnId: 'turn-1' }
        );

        expect(result.envelopes).toHaveLength(1);
        expect(result.envelopes[0]).toMatchObject({
            role: 'agent',
            turn: 'turn-1',
            usage: {
                input_tokens: 10,
                output_tokens: 0,
            },
            ev: { t: 'service', text: '' },
        });
        expect(result.currentTurnId).toBe('turn-1');
    });

    it('normalizes camelCase token_count usage fields', () => {
        const result = mapCodexMcpMessageToSessionEnvelopes(
            {
                type: 'token_count',
                inputTokens: 1200,
                outputTokens: 50,
                cacheCreationInputTokens: 20,
                cacheReadInputTokens: 300,
            },
            { currentTurnId: null }
        );

        expect(result.envelopes).toHaveLength(1);
        expect(result.envelopes[0]).toMatchObject({
            role: 'agent',
            usage: {
                input_tokens: 1200,
                cache_creation_input_tokens: 20,
                cache_read_input_tokens: 300,
                output_tokens: 50,
            },
            ev: { t: 'service', text: '' },
        });
        expect(result.envelopes[0].turn).toBeUndefined();
    });

    it('uses nested codex last token usage for current context', () => {
        const result = mapCodexMcpMessageToSessionEnvelopes(
            {
                type: 'token_count',
                total: {
                    totalTokens: 1157682,
                    inputTokens: 1151131,
                    cachedInputTokens: 1030784,
                    outputTokens: 6551,
                    reasoningOutputTokens: 276,
                },
                last: {
                    totalTokens: 126098,
                    inputTokens: 123958,
                    cachedInputTokens: 113536,
                    outputTokens: 2140,
                    reasoningOutputTokens: 44,
                },
                modelContextWindow: 258400,
            },
            { currentTurnId: 'turn-1' }
        );

        expect(result.envelopes).toHaveLength(1);
        expect(result.envelopes[0]).toMatchObject({
            role: 'agent',
            turn: 'turn-1',
            usage: {
                input_tokens: 10422,
                cache_read_input_tokens: 113536,
                output_tokens: 2140,
                context_window: 258400,
            },
            ev: { t: 'service', text: '' },
        });
    });
});

describe('mapCodexProcessorMessageToSessionEnvelopes', () => {
    it('maps reasoning tool lifecycle to start/text/end session events', () => {
        const startEvents = mapCodexProcessorMessageToSessionEnvelopes({
            type: 'tool-call',
            callId: 'reasoning-1',
            name: 'CodexReasoning',
            input: { title: 'Plan changes' },
            id: 'legacy-id-1',
        }, { currentTurnId: 'turn-1' });

        expect(startEvents).toHaveLength(1);
        expect(startEvents[0].ev.t).toBe('tool-call-start');

        const endEvents = mapCodexProcessorMessageToSessionEnvelopes({
            type: 'tool-call-result',
            callId: 'reasoning-1',
            output: { content: 'Step 1, Step 2', status: 'completed' },
            id: 'legacy-id-2',
        }, { currentTurnId: 'turn-1' });

        expect(endEvents).toHaveLength(2);
        expect(endEvents[0].ev.t).toBe('text');
        if (endEvents[0].ev.t === 'text') {
            expect(endEvents[0].ev.thinking).toBe(true);
        }
        expect(endEvents[1].ev).toEqual({ t: 'tool-call-end', call: 'reasoning-1' });
    });

    it('maps reasoning text to thinking text event', () => {
        const events = mapCodexProcessorMessageToSessionEnvelopes({
            type: 'reasoning',
            message: 'Working through options',
            id: 'legacy-id-3',
        }, { currentTurnId: 'turn-1' });

        expect(events).toHaveLength(1);
        expect(events[0].ev).toEqual({
            t: 'text',
            text: 'Working through options',
            thinking: true,
        });
    });
});

describe('mapCodexThreadToSessionEnvelopes', () => {
    it('backfills Codex thread turns as session envelopes with codex item ids', () => {
        const envelopes = mapCodexThreadToSessionEnvelopes({
            turns: [{
                id: 'turn-1',
                startedAt: 100,
                completedAt: 101,
                status: 'completed',
                items: [
                    { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'hello codex' }] },
                    { id: 'agent-1', type: 'agentMessage', text: 'hello human' },
                ],
            }],
        });

        expect(envelopes.map((envelope) => envelope.ev.t)).toEqual([
            'turn-start',
            'text',
            'text',
            'turn-end',
        ]);
        expect(envelopes[1]).toMatchObject({
            role: 'user',
            id: 'user-1',
            codexItemId: 'user-1',
            ev: { t: 'text', text: 'hello codex' },
        });
        expect(envelopes[2]).toMatchObject({
            role: 'agent',
            id: 'agent-1',
            turn: 'turn-1',
            codexItemId: 'agent-1',
            ev: { t: 'text', text: 'hello human' },
        });
    });

    it('backfills Codex command execution items as tool calls', () => {
        const envelopes = mapCodexThreadToSessionEnvelopes({
            turns: [{
                id: 'turn-1',
                startedAt: 100,
                items: [
                    {
                        id: 'cmd-1',
                        type: 'commandExecution',
                        command: 'pnpm test',
                        cwd: '/tmp/project',
                        aggregatedOutput: 'ok',
                    },
                ],
            }],
        });

        expect(envelopes.map((envelope) => envelope.ev.t)).toEqual([
            'turn-start',
            'tool-call-start',
            'text',
            'tool-call-end',
            'turn-end',
        ]);
        expect(envelopes[1]).toMatchObject({
            role: 'agent',
            turn: 'turn-1',
            ev: { t: 'tool-call-start', call: 'cmd-1', name: 'CodexBash' },
        });
        expect(envelopes[2]).toMatchObject({
            role: 'agent',
            turn: 'turn-1',
            ev: { t: 'text', text: 'ok', thinking: true },
        });
        expect(envelopes[3]).toMatchObject({
            role: 'agent',
            turn: 'turn-1',
            ev: { t: 'tool-call-end', call: 'cmd-1' },
        });
    });

    it('backfills Codex collab-agent items with session subagent linkage', () => {
        const envelopes = mapCodexThreadToSessionEnvelopes({
            turns: [{
                id: 'turn-1',
                startedAt: 100,
                completedAt: 101,
                status: 'completed',
                items: [
                    {
                        id: 'collab-1',
                        type: 'collabAgentToolCall',
                        tool: 'spawnAgent',
                        status: 'completed',
                        senderThreadId: 'parent-thread',
                        receiverThreadIds: ['provider-child-thread'],
                        prompt: 'Inspect auth flow',
                        model: 'gpt-test',
                        reasoningEffort: null,
                        agentsStates: {},
                    },
                    {
                        id: 'activity-1',
                        type: 'subAgentActivity',
                        kind: 'interacted',
                        agentThreadId: 'provider-child-thread',
                        agentPath: 'Auth explorer',
                    },
                ],
            }],
        });

        const toolCall = envelopes.find((envelope) => envelope.ev.t === 'tool-call-start');
        expect(toolCall).toBeDefined();
        if (toolCall?.ev.t === 'tool-call-start') {
            expect(toolCall.ev.name).toBe('CodexSubagent');
            expect(isCuid(String(toolCall.ev.args.sessionSubagent))).toBe(true);
            expect(toolCall.ev.args.sessionSubagent).not.toBe('provider-child-thread');
        }

        const starts = envelopes.filter((envelope) => envelope.ev.t === 'start');
        expect(starts).toHaveLength(1);
        expect(starts[0].subagent).toBe(
            toolCall?.ev.t === 'tool-call-start' ? toolCall.ev.args.sessionSubagent : undefined
        );
        expect(envelopes.some((envelope) => {
            return envelope.ev.t === 'stop' && envelope.subagent === starts[0].subagent;
        })).toBe(true);
    });

    it('does not close in-progress historical collab-agent items or active turns', () => {
        const envelopes = mapCodexThreadToSessionEnvelopes({
            turns: [{
                id: 'turn-active',
                startedAt: 100,
                status: 'inProgress',
                items: [
                    {
                        id: 'collab-active',
                        type: 'collabAgentToolCall',
                        tool: 'spawnAgent',
                        status: 'inProgress',
                        receiverThreadIds: ['provider-child-thread'],
                        prompt: 'Inspect auth flow',
                    },
                ],
            }],
        });

        expect(envelopes.map((envelope) => envelope.ev.t)).toEqual([
            'turn-start',
            'tool-call-start',
            'start',
        ]);
    });

    it('backfills subagent-scoped historical reasoning and agent messages into sidechains', () => {
        const envelopes = mapCodexThreadToSessionEnvelopes({
            turns: [{
                id: 'turn-1',
                startedAt: 100,
                completedAt: 101,
                status: 'completed',
                items: [
                    {
                        id: 'activity-1',
                        type: 'subAgentActivity',
                        kind: 'started',
                        agentThreadId: 'provider-child-thread',
                        agentPath: 'Auth explorer',
                    },
                    {
                        id: 'reasoning-1',
                        type: 'reasoning',
                        summary: ['checking auth flow'],
                        agentThreadId: 'provider-child-thread',
                    } as any,
                    {
                        id: 'agent-1',
                        type: 'agentMessage',
                        text: 'found auth handler',
                        agentThreadId: 'provider-child-thread',
                    } as any,
                ],
            }],
        });

        const start = envelopes.find((envelope) => envelope.ev.t === 'start');
        expect(start?.subagent).toBeDefined();
        expect(isCuid(start!.subagent!)).toBe(true);

        const reasoning = envelopes.find((envelope) => envelope.codexItemId === 'reasoning-1');
        expect(reasoning).toMatchObject({
            subagent: start?.subagent,
            ev: { t: 'text', text: 'checking auth flow', thinking: true },
        });

        const text = envelopes.find((envelope) => envelope.codexItemId === 'agent-1');
        expect(text).toMatchObject({
            subagent: start?.subagent,
            ev: { t: 'text', text: 'found auth handler' },
        });
    });

    it('uses stable session subagent ids across historical replay turns', () => {
        const envelopes = mapCodexThreadToSessionEnvelopes({
            turns: [
                {
                    id: 'turn-1',
                    startedAt: 100,
                    completedAt: 101,
                    status: 'completed',
                    items: [{
                        id: 'collab-1',
                        type: 'collabAgentToolCall',
                        tool: 'spawnAgent',
                        status: 'completed',
                        receiverThreadIds: ['provider-child-thread'],
                        prompt: 'Inspect auth flow',
                    }],
                },
                {
                    id: 'turn-2',
                    startedAt: 102,
                    completedAt: 103,
                    status: 'completed',
                    items: [{
                        id: 'activity-2',
                        type: 'subAgentActivity',
                        kind: 'interacted',
                        agentThreadId: 'provider-child-thread',
                    }],
                },
            ],
        });

        const subagents = envelopes
            .filter((envelope) => envelope.ev.t === 'start')
            .map((envelope) => envelope.subagent);
        expect(subagents).toHaveLength(2);
        expect(subagents[1]).toBe(subagents[0]);
        expect(isCuid(subagents[0]!)).toBe(true);
    });

    it('uses one fallback timestamp pair for historical tool items without provider timestamps', () => {
        const dateSpy = vi
            .spyOn(Date, 'now')
            .mockReturnValueOnce(10_000)
            .mockReturnValueOnce(20_000);

        try {
            const envelopes = mapCodexThreadToSessionEnvelopes({
                turns: [{
                    id: 'turn-without-times',
                    items: [
                        {
                            id: 'cmd-1',
                            type: 'commandExecution',
                            command: 'pnpm test',
                            aggregatedOutput: 'ok',
                        },
                    ],
                }],
            });

            expect(envelopes.map((envelope) => envelope.time)).toEqual([
                10_000,
                10_000,
                10_000,
                20_000,
                20_000,
            ]);
        } finally {
            dateSpy.mockRestore();
        }
    });
});
