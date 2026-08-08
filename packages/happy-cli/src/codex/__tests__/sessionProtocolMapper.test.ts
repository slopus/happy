import { describe, expect, it } from 'vitest';
import { isCuid } from '@paralleldrive/cuid2';
import {
    extractSkillNamesFromCommand,
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

    it('keeps one root turn while mapping a spawned child thread to a stable subagent', () => {
        const started = mapCodexMcpMessageToSessionEnvelopes(
            { type: 'task_started', turn_id: 'provider-root-turn' },
            { currentTurnId: null },
        );
        const rootTurn = started.currentTurnId;
        expect(rootTurn).not.toBeNull();

        const spawned = mapCodexMcpMessageToSessionEnvelopes({
            type: 'collab_agent_tool_begin',
            call_id: 'collab-spawn-1',
            tool: 'spawnAgent',
            receiver_thread_ids: ['thread-child'],
            prompt: 'Review the implementation',
            model: 'gpt-test',
            reasoning_effort: 'high',
        }, started);

        expect(spawned.envelopes).toHaveLength(2);
        expect(spawned.envelopes[0]).toMatchObject({
            role: 'agent',
            turn: rootTurn,
            ev: {
                t: 'tool-call-start',
                call: 'collab-spawn-1',
                name: 'Agent',
                args: {
                    prompt: 'Review the implementation',
                },
            },
        });
        expect(spawned.envelopes[0].subagent).toBeUndefined();
        if (spawned.envelopes[0].ev.t !== 'tool-call-start') {
            throw new Error('Expected collaboration tool call start');
        }
        const sessionSubagent = spawned.envelopes[0].ev.args.sessionSubagent;
        expect(typeof sessionSubagent).toBe('string');
        expect(isCuid(sessionSubagent as string)).toBe(true);
        expect(spawned.envelopes[1]).toMatchObject({
            role: 'agent',
            turn: rootTurn,
            subagent: sessionSubagent,
            ev: { t: 'start', title: 'Review the implementation' },
        });

        const childFirst = mapCodexMcpMessageToSessionEnvelopes({
            type: 'agent_message',
            message: 'Child progress',
            subagent: 'thread-child',
        }, spawned);
        expect(childFirst.envelopes).toHaveLength(1);
        expect(childFirst.envelopes[0]).toMatchObject({
            role: 'agent',
            turn: rootTurn,
            subagent: sessionSubagent,
            ev: { t: 'text', text: 'Child progress' },
        });

        const childSecond = mapCodexMcpMessageToSessionEnvelopes({
            type: 'agent_message',
            message: 'Child final',
            subagent: 'thread-child',
        }, childFirst);
        expect(childSecond.envelopes).toHaveLength(1);
        expect(childSecond.envelopes[0]).toMatchObject({
            turn: rootTurn,
            subagent: sessionSubagent,
            ev: { t: 'text', text: 'Child final' },
        });

        const rootFinal = mapCodexMcpMessageToSessionEnvelopes({
            type: 'agent_message',
            message: 'Root final',
        }, childSecond);
        expect(rootFinal.currentTurnId).toBe(rootTurn);
        expect(rootFinal.envelopes[0]).toMatchObject({
            turn: rootTurn,
            ev: { t: 'text', text: 'Root final' },
        });
        expect(rootFinal.envelopes[0].subagent).toBeUndefined();
    });

    it('keeps child lifecycle independent when the root turn ends first', () => {
        const spawned = mapCodexMcpMessageToSessionEnvelopes({
            type: 'collab_agent_tool_begin',
            call_id: 'late-child-spawn',
            tool: 'spawnAgent',
            receiver_thread_ids: ['late-child-thread'],
            prompt: 'Finish after root',
        }, { currentTurnId: 'turn-1' });
        const subagent = spawned.envelopes[1].subagent;

        const ended = mapCodexMcpMessageToSessionEnvelopes(
            { type: 'task_complete' },
            spawned,
        );
        expect(ended.envelopes).toHaveLength(1);
        expect(ended.envelopes[0].ev).toEqual({
            t: 'turn-end',
            status: 'completed',
        });
        expect(ended.activeSubagents.has(subagent!)).toBe(true);

        const lateProgress = mapCodexMcpMessageToSessionEnvelopes({
            type: 'agent_message',
            subagent: 'late-child-thread',
            message: 'Still finishing after root',
        }, ended);
        expect(lateProgress.envelopes).toEqual([
            expect.objectContaining({
                turn: 'turn-1',
                subagent,
                ev: { t: 'text', text: 'Still finishing after root' },
            }),
        ]);

        const nextRoot = mapCodexMcpMessageToSessionEnvelopes({ type: 'task_started' }, lateProgress);
        expect(nextRoot.currentTurnId).not.toBe('turn-1');
        const progressDuringNextRoot = mapCodexMcpMessageToSessionEnvelopes({
            type: 'agent_message',
            subagent: 'late-child-thread',
            message: 'Old child while next root runs',
        }, nextRoot);
        expect(progressDuringNextRoot.envelopes[0]).toMatchObject({
            turn: 'turn-1',
            subagent,
            ev: { t: 'text', text: 'Old child while next root runs' },
        });

        const childEnded = mapCodexMcpMessageToSessionEnvelopes({
            type: 'subagent_completed',
            subagent: 'late-child-thread',
            status: 'failed',
        }, progressDuringNextRoot);
        expect(childEnded.currentTurnId).toBe(nextRoot.currentTurnId);
        expect(childEnded.envelopes).toEqual([
            expect.objectContaining({
                turn: 'turn-1',
                subagent,
                ev: { t: 'stop', status: 'failed' },
            }),
        ]);
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

    it('promotes SKILL.md reads into named Skill activity', () => {
        const result = mapCodexMcpMessageToSessionEnvelopes(
            {
                type: 'exec_command_begin',
                call_id: 'call-skill',
                command: '/bin/zsh -lc "sed -n 1,200p /Users/jacky/jacky-github/jacky-skills/plugins/obsidian-tools/ob-chat/SKILL.md"',
                cwd: '/repo',
            },
            { currentTurnId: 'turn-1' },
        );

        expect(result.envelopes[0]).toMatchObject({
            ev: {
                t: 'tool-call-start',
                name: 'Skill',
                title: 'Use skill `obsidian-tools:ob-chat`',
                args: { skillNames: ['obsidian-tools:ob-chat'] },
            },
        });
    });

    it('marks a failed Skill command as failed', () => {
        const result = mapCodexMcpMessageToSessionEnvelopes({
            type: 'exec_command_end',
            call_id: 'call-skill-failed',
            exit_code: 1,
        }, { currentTurnId: 'turn-1' });

        expect(result.envelopes[0]).toMatchObject({
            ev: {
                t: 'tool-call-end',
                call: 'call-skill-failed',
                status: 'failed',
            },
        });
    });

    it('fails a spawned child lifecycle when the collaboration call fails', () => {
        const spawned = mapCodexMcpMessageToSessionEnvelopes({
            type: 'collab_agent_tool_begin',
            call_id: 'failed-spawn',
            tool: 'spawnAgent',
            receiver_thread_ids: ['failed-child-thread'],
            prompt: 'This spawn fails',
        }, { currentTurnId: 'turn-1' });
        const subagent = spawned.envelopes[1].subagent;

        const failed = mapCodexMcpMessageToSessionEnvelopes({
            type: 'collab_agent_tool_end',
            call_id: 'failed-spawn',
            status: 'failed',
        }, spawned);

        expect(failed.envelopes).toEqual(expect.arrayContaining([
            expect.objectContaining({
                ev: { t: 'tool-call-end', call: 'failed-spawn', status: 'failed' },
            }),
            expect.objectContaining({
                turn: 'turn-1',
                subagent,
                ev: { t: 'stop', status: 'failed' },
            }),
        ]));
        expect(failed.activeSubagents.has(subagent!)).toBe(false);
    });

    it('ends a child lifecycle without ending the root turn', () => {
        const spawned = mapCodexMcpMessageToSessionEnvelopes({
            type: 'collab_agent_tool_begin',
            call_id: 'collab-spawn-1',
            tool: 'spawnAgent',
            receiver_thread_ids: ['thread-child'],
            prompt: 'Review UI',
        }, { currentTurnId: 'turn-1' });

        const completed = mapCodexMcpMessageToSessionEnvelopes({
            type: 'subagent_completed',
            subagent: 'thread-child',
            status: 'interrupted',
        }, spawned);

        expect(completed.currentTurnId).toBe('turn-1');
        expect(completed.envelopes).toHaveLength(1);
        expect(completed.envelopes[0]).toMatchObject({
            subagent: spawned.envelopes[1].subagent,
            ev: { t: 'stop', status: 'cancelled' },
        });

        const waited = mapCodexMcpMessageToSessionEnvelopes({
            type: 'collab_agent_tool_begin',
            call_id: 'collab-wait-1',
            tool: 'wait',
            receiver_thread_ids: ['thread-child'],
        }, completed);
        expect(waited.envelopes).toHaveLength(1);
        expect(waited.envelopes[0].ev.t).toBe('tool-call-start');
    });

    it('keeps a reusable provider child bound to its original Agent owner after completion', () => {
        const spawned = mapCodexMcpMessageToSessionEnvelopes({
            type: 'collab_agent_tool_begin',
            call_id: 'collab-spawn-reusable',
            tool: 'spawnAgent',
            receiver_thread_ids: ['thread-reusable-child'],
            prompt: 'Review repeatedly',
        }, { currentTurnId: 'turn-1' });
        const owner = spawned.envelopes.find((envelope) => (
            envelope.ev.t === 'tool-call-start' && envelope.ev.name === 'Agent'
        ));
        const ownedSubagent = owner?.ev.t === 'tool-call-start'
            ? owner.ev.args.sessionSubagent
            : undefined;

        const firstMessage = mapCodexMcpMessageToSessionEnvelopes({
            type: 'agent_message',
            subagent: 'thread-reusable-child',
            message: 'First review complete',
        }, spawned);
        const completed = mapCodexMcpMessageToSessionEnvelopes({
            type: 'subagent_completed',
            subagent: 'thread-reusable-child',
            status: 'completed',
        }, firstMessage);
        const followUpMessage = mapCodexMcpMessageToSessionEnvelopes({
            type: 'agent_message',
            subagent: 'thread-reusable-child',
            message: 'Follow-up review complete',
        }, completed);
        const followUpCompleted = mapCodexMcpMessageToSessionEnvelopes({
            type: 'subagent_completed',
            subagent: 'thread-reusable-child',
            status: 'completed',
        }, followUpMessage);
        const rootCompleted = mapCodexMcpMessageToSessionEnvelopes({
            type: 'task_complete',
        }, followUpCompleted);
        const nextRoot = mapCodexMcpMessageToSessionEnvelopes({
            type: 'task_started',
        }, rootCompleted);
        const lateMessage = mapCodexMcpMessageToSessionEnvelopes({
            type: 'agent_message',
            subagent: 'thread-reusable-child',
            message: 'Late review from the previous root turn',
        }, nextRoot);

        expect(ownedSubagent).toEqual(expect.any(String));
        expect(firstMessage.envelopes).toEqual([
            expect.objectContaining({
                turn: 'turn-1',
                subagent: ownedSubagent,
                ev: { t: 'text', text: 'First review complete' },
            }),
        ]);
        expect(followUpMessage.envelopes).toEqual([
            expect.objectContaining({
                turn: 'turn-1',
                subagent: ownedSubagent,
                ev: { t: 'start' },
            }),
            expect.objectContaining({
                turn: 'turn-1',
                subagent: ownedSubagent,
                ev: { t: 'text', text: 'Follow-up review complete' },
            }),
        ]);
        expect(lateMessage.envelopes).toEqual([
            expect.objectContaining({
                turn: 'turn-1',
                subagent: ownedSubagent,
                ev: { t: 'start' },
            }),
            expect.objectContaining({
                turn: 'turn-1',
                subagent: ownedSubagent,
                ev: { t: 'text', text: 'Late review from the previous root turn' },
            }),
        ]);
    });

    it('skips token_count messages', () => {
        const result = mapCodexMcpMessageToSessionEnvelopes(
            { type: 'token_count', total_tokens: 10 },
            { currentTurnId: 'turn-1' }
        );

        expect(result.envelopes).toHaveLength(0);
        expect(result.currentTurnId).toBe('turn-1');
    });
});

describe('extractSkillNamesFromCommand', () => {
    it('deduplicates personal and plugin skill paths', () => {
        expect(extractSkillNamesFromCommand(
            "sed -n '1,200p' /Users/a/.agents/skills/dev/SKILL.md /repo/plugins/obsidian-tools/skills/ob-chat/SKILL.md /repo/plugins/obsidian-tools/skills/ob-chat/SKILL.md",
        )).toEqual(['dev', 'obsidian-tools:ob-chat']);
    });

    it('recognizes the actual local plugin layout through a shell wrapper', () => {
        expect(extractSkillNamesFromCommand(
            '/bin/zsh -lc "sed -n 1,240p /Users/jacky/jacky-github/jacky-skills/plugins/obsidian-tools/ob-chat/SKILL.md"',
        )).toEqual(['obsidian-tools:ob-chat']);
    });

    it('uses the bundled plugin identity instead of cache path components', () => {
        expect(extractSkillNamesFromCommand(
            'sed -n 1,240p ~/.codex/plugins/cache/openai-bundled/browser/26.707.31428/skills/control-in-app-browser/SKILL.md',
        )).toEqual(['browser:control-in-app-browser']);
    });

    it('recognizes Windows skill paths read with Get-Content', () => {
        expect(extractSkillNamesFromCommand(
            'Get-Content "C:\\Users\\a\\.agents\\skills\\dev\\SKILL.md"',
        )).toEqual(['dev']);
    });

    it('does not treat a diff path as Skill usage', () => {
        expect(extractSkillNamesFromCommand(
            'git diff -- /repo/plugins/obsidian-tools/skills/ob-chat/SKILL.md',
        )).toEqual([]);
    });

    it('does not treat a quoted read command printed by echo as Skill usage', () => {
        expect(extractSkillNamesFromCommand(
            'echo "cat /Users/jacky/jacky-github/jacky-skills/plugins/obsidian-tools/ob-chat/SKILL.md"',
        )).toEqual([]);
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

    it('backfills inline review results from exitedReviewMode items', () => {
        const envelopes = mapCodexThreadToSessionEnvelopes({
            turns: [{
                id: 'turn-review-1',
                startedAt: 100,
                completedAt: 105,
                status: 'completed',
                items: [
                    {
                        id: 'review-item-1',
                        type: 'exitedReviewMode',
                        review: 'Findings: none.',
                    },
                ],
            }],
        });

        expect(envelopes.map((envelope) => envelope.ev.t)).toEqual([
            'turn-start',
            'text',
            'turn-end',
        ]);
        expect(envelopes[1]).toMatchObject({
            role: 'agent',
            turn: 'turn-review-1',
            codexItemId: 'review-item-1',
            ev: { t: 'text', text: 'Findings: none.' },
        });
    });
});
