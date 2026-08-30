import { describe, expect, it } from 'vitest';
import { isCuid } from '@paralleldrive/cuid2';
import {
    extractSkillNamesFromCommand,
    mapCodexMcpMessageToSessionEnvelopes,
    mapCodexProcessorMessageToSessionEnvelopes,
    mapCodexThreadToSessionEnvelopes,
} from '../utils/sessionProtocolMapper';
import {
    buildCodexTurnPrompt,
    CODEX_HAPPY_SYSTEM_PROMPT_END,
    CODEX_HAPPY_SYSTEM_PROMPT_START,
    markPawsTurnOrigin,
} from '../codexPrompt';

describe('mapCodexMcpMessageToSessionEnvelopes', () => {
    it('maps a Codex Desktop user item into a root user envelope', () => {
        const result = mapCodexMcpMessageToSessionEnvelopes({
            type: 'user_message',
            item_id: 'user-desktop-1',
            content: [{ type: 'text', text: 'Continue from Codex Desktop.' }],
        }, { currentTurnId: 'turn-desktop-1' });

        expect(result.envelopes).toEqual([
            expect.objectContaining({
                id: expect.stringMatching(/^codex-text:/),
                codexItemId: 'user-desktop-1',
                role: 'user',
                turn: 'turn-desktop-1',
                ev: { t: 'text', text: 'Continue from Codex Desktop.' },
            }),
        ]);
    });

    it('starts and ends turns for task lifecycle events', () => {
        const started = mapCodexMcpMessageToSessionEnvelopes(
            { type: 'task_started', turn_id: 'codex-turn-1' },
            { currentTurnId: null },
        );

        expect(started.envelopes).toHaveLength(1);
        expect(started.envelopes[0].ev.t).toBe('turn-start');
        expect(started.currentTurnId).toBe('codex-turn-1');
        expect(started.envelopes[0]).toMatchObject({
            id: 'codex-turn-1:start',
            turn: 'codex-turn-1',
        });

        const ended = mapCodexMcpMessageToSessionEnvelopes({ type: 'task_complete' }, { currentTurnId: started.currentTurnId });
        expect(ended.envelopes).toHaveLength(1);
        expect(ended.envelopes[0].ev.t).toBe('turn-end');
        if (ended.envelopes[0].ev.t === 'turn-end') {
            expect(ended.envelopes[0].ev.status).toBe('completed');
        }
        expect(ended.envelopes[0].id).toBe('codex-turn-1:end');
        expect(ended.envelopes[0].turn).toBe(started.currentTurnId);
        expect(ended.currentTurnId).toBeNull();
    });

    it('uses an event turn ID without clearing a newer active turn', () => {
        const text = mapCodexMcpMessageToSessionEnvelopes(
            { type: 'agent_message', turn_id: 'turn-older', message: 'Older turn finished.' },
            { currentTurnId: 'turn-newer' },
        );
        expect(text.envelopes[0]).toMatchObject({
            turn: 'turn-older',
            ev: { t: 'text', text: 'Older turn finished.' },
        });
        expect(text.currentTurnId).toBe('turn-newer');

        const ended = mapCodexMcpMessageToSessionEnvelopes(
            { type: 'task_complete', turn_id: 'turn-older' },
            { currentTurnId: text.currentTurnId },
        );
        expect(ended.envelopes[0]).toMatchObject({
            id: 'turn-older:end',
            turn: 'turn-older',
            ev: { t: 'turn-end', status: 'completed' },
        });
        expect(ended.currentTurnId).toBe('turn-newer');

        const newerEnded = mapCodexMcpMessageToSessionEnvelopes(
            { type: 'task_complete', turn_id: 'turn-newer' },
            { currentTurnId: ended.currentTurnId },
        );
        expect(newerEnded.currentTurnId).toBeNull();
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
            { type: 'agent_message', message: 'hello', item_id: 'agent-item-1' },
            { currentTurnId: 'turn-1' }
        );

        expect(result.envelopes).toHaveLength(1);
        expect(result.envelopes[0].id).toMatch(/^codex-text:/);
        expect(result.envelopes[0].codexItemId).toBe('agent-item-1');
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
        expect(spawned.envelopes[0].ev.args.providerThreadId).toBe('thread-child');
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
    it('omits a replayed Paws user message only for the opaque origin that stored it', () => {
        const thread = {
            turns: [{
                id: 'turn-paws-1',
                startedAt: 100,
                items: [
                    {
                        id: 'user-paws-1',
                        type: 'userMessage' as const,
                        content: [{ type: 'text' as const, text: markPawsTurnOrigin('continue remotely', 'paws-origin-a') }],
                    },
                    { id: 'agent-paws-1', type: 'agentMessage' as const, text: 'done' },
                ],
            }],
        };

        const sameSession = mapCodexThreadToSessionEnvelopes(thread, {
            omitPawsUserMessagesFromOriginToken: 'paws-origin-a',
        });
        expect(sameSession.some((envelope) => envelope.role === 'user')).toBe(false);
        expect(sameSession).toEqual(expect.arrayContaining([
            expect.objectContaining({ role: 'agent', ev: { t: 'text', text: 'done' } }),
        ]));

        const otherSession = mapCodexThreadToSessionEnvelopes(thread, {
            omitPawsUserMessagesFromOriginToken: 'paws-origin-b',
        });
        expect(otherSession).toEqual(expect.arrayContaining([
            expect.objectContaining({ role: 'user', ev: { t: 'text', text: 'continue remotely' } }),
        ]));
    });

    it('keeps only the user request when a fork backfills a constructed runtime-settings prompt', () => {
        const userRequest = 'Continue with the implementation plan.';
        const prompt = buildCodexTurnPrompt({
            message: userRequest,
            mode: { model: 'gpt-5.6-terra', effort: 'high' },
            includeAppendSystemPrompt: false,
            includeTitleInstruction: false,
        });
        const envelopes = mapCodexThreadToSessionEnvelopes({
            turns: [{
                id: 'turn-1',
                startedAt: 100,
                items: [{
                    id: 'user-1',
                    type: 'userMessage',
                    content: [{ type: 'text', text: prompt }],
                }],
            }],
        });

        expect(envelopes).toEqual(expect.arrayContaining([
            expect.objectContaining({
                role: 'user',
                ev: { t: 'text', text: userRequest },
            }),
        ]));
    });

    it('excludes internal Happy system instructions from forked transcript messages', () => {
        const envelopes = mapCodexThreadToSessionEnvelopes({
            turns: [{
                id: 'turn-1',
                startedAt: 100,
                items: [{
                    id: 'user-1',
                    type: 'userMessage',
                    content: [{
                        type: 'text',
                        text: [
                            CODEX_HAPPY_SYSTEM_PROMPT_START,
                            'Internal Happy system instructions.',
                            CODEX_HAPPY_SYSTEM_PROMPT_END,
                            'Real user request.',
                            CODEX_HAPPY_SYSTEM_PROMPT_START,
                            'Internal title instruction.',
                            CODEX_HAPPY_SYSTEM_PROMPT_END,
                        ].join('\n\n'),
                    }],
                }],
            }],
        });

        expect(envelopes).toEqual(expect.arrayContaining([
            expect.objectContaining({
                role: 'user',
                ev: { t: 'text', text: 'Real user request.' },
            }),
        ]));
    });

    it('does not backfill a user message containing only internal Happy system instructions', () => {
        const envelopes = mapCodexThreadToSessionEnvelopes({
            turns: [{
                id: 'turn-1',
                startedAt: 100,
                items: [{
                    id: 'user-1',
                    type: 'userMessage',
                    content: [{
                        type: 'text',
                        text: `${CODEX_HAPPY_SYSTEM_PROMPT_START}Internal instructions.${CODEX_HAPPY_SYSTEM_PROMPT_END}`,
                    }],
                }],
            }],
        });

        expect(envelopes.map((envelope) => envelope.ev.t)).toEqual(['turn-start', 'turn-end']);
    });

    it('does not backfill legacy Codex runtime context from existing forks', () => {
        const envelopes = mapCodexThreadToSessionEnvelopes({
            turns: [{
                id: 'turn-1',
                startedAt: 100,
                items: [
                    {
                        id: 'runtime-options',
                        type: 'userMessage',
                        content: [{
                            type: 'text',
                            text: [
                                '# Options',
                                'You have a way to give a user a easy way to answer your questions.',
                                'Whenever you need to show the user an image, call the send_image tool.',
                            ].join('\n\n'),
                        }],
                    },
                    {
                        id: 'runtime-agents',
                        type: 'userMessage',
                        content: [{
                            type: 'text',
                            text: '# AGENTS.md instructions\n\n<environment_context>runtime details</environment_context>',
                        }],
                    },
                ],
            }],
        });

        expect(envelopes.map((envelope) => envelope.ev.t)).toEqual(['turn-start', 'turn-end']);
    });

    it('retains a user message that merely mentions options or AGENTS.md', () => {
        const envelopes = mapCodexThreadToSessionEnvelopes({
            turns: [{
                id: 'turn-1',
                startedAt: 100,
                items: [{
                    id: 'user-1',
                    type: 'userMessage',
                    content: [{
                        type: 'text',
                        text: 'Please add an Options section to AGENTS.md.',
                    }],
                }],
            }],
        });

        expect(envelopes).toEqual(expect.arrayContaining([
            expect.objectContaining({
                role: 'user',
                ev: { t: 'text', text: 'Please add an Options section to AGENTS.md.' },
            }),
        ]));
    });

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
            id: expect.stringMatching(/^codex-text:/),
            turn: 'turn-1',
            codexItemId: 'user-1',
            ev: { t: 'text', text: 'hello codex' },
        });
        expect(envelopes[2]).toMatchObject({
            role: 'agent',
            id: expect.stringMatching(/^codex-text:/),
            turn: 'turn-1',
            codexItemId: 'agent-1',
            ev: { t: 'text', text: 'hello human' },
        });
    });

    it('uses the same text envelope IDs for live notifications and thread history', () => {
        const liveUser = mapCodexMcpMessageToSessionEnvelopes({
            type: 'user_message',
            item_id: 'msg-live-user',
            content: [{ type: 'text', text: 'same user text' }],
        }, { currentTurnId: 'turn-stable-1' }).envelopes[0];
        const liveAgent = mapCodexMcpMessageToSessionEnvelopes({
            type: 'agent_message',
            item_id: 'msg-live-agent',
            message: 'same agent text',
        }, { currentTurnId: 'turn-stable-1' }).envelopes[0];
        const historical = mapCodexThreadToSessionEnvelopes({
            turns: [{
                id: 'turn-stable-1',
                items: [
                    { id: 'item-history-user', type: 'userMessage', content: [{ type: 'text', text: 'same user text' }] },
                    { id: 'item-history-agent', type: 'agentMessage', text: 'same agent text' },
                ],
            }],
        });
        const historicalUser = historical.find((envelope) => envelope.role === 'user');
        const historicalAgent = historical.find((envelope) => envelope.role === 'agent' && envelope.ev.t === 'text');

        expect(liveUser.id).toBe(historicalUser?.id);
        expect(liveAgent.id).toBe(historicalAgent?.id);
        expect(liveUser.codexItemId).not.toBe(historicalUser?.codexItemId);
        expect(liveAgent.codexItemId).not.toBe(historicalAgent?.codexItemId);
    });

    it('keeps repeated identical text distinct while matching live and historical occurrences', () => {
        const liveState = {
            currentTurnId: 'turn-repeated-1',
            textEnvelopeOccurrences: new Map<string, number>(),
        };
        const liveFirst = mapCodexMcpMessageToSessionEnvelopes({
            type: 'agent_message',
            item_id: 'msg-live-1',
            message: 'repeated text',
        }, liveState).envelopes[0];
        const liveSecond = mapCodexMcpMessageToSessionEnvelopes({
            type: 'agent_message',
            item_id: 'msg-live-2',
            message: 'repeated text',
        }, liveState).envelopes[0];
        const historical = mapCodexThreadToSessionEnvelopes({
            turns: [{
                id: 'turn-repeated-1',
                items: [
                    { id: 'item-history-1', type: 'agentMessage', text: 'repeated text' },
                    { id: 'item-history-2', type: 'agentMessage', text: 'repeated text' },
                ],
            }],
        }).filter((envelope) => envelope.role === 'agent' && envelope.ev.t === 'text');

        expect(liveFirst.id).not.toBe(liveSecond.id);
        expect(historical).toHaveLength(2);
        expect(liveFirst.id).toBe(historical[0].id);
        expect(liveSecond.id).toBe(historical[1].id);
    });

    it('replays only the active user request and deduplicates a concurrent live user event', () => {
        const historical = mapCodexThreadToSessionEnvelopes({
            turns: [{
                id: 'turn-active-1',
                status: 'inProgress',
                items: [
                    { id: 'item-user-history', type: 'userMessage', content: [{ type: 'text', text: 'active request' }] },
                    { id: 'item-partial', type: 'agentMessage', text: 'partial agent text' },
                ],
            }],
        }, { activeTurnsUserOnly: true });
        const historicalUser = historical.find((envelope) => envelope.role === 'user');
        const liveUser = mapCodexMcpMessageToSessionEnvelopes({
            type: 'user_message',
            item_id: 'msg-live-user',
            content: [{ type: 'text', text: 'active request' }],
        }, {
            currentTurnId: 'turn-active-1',
        }).envelopes[0];

        expect(historical.some((envelope) => envelope.ev.t === 'turn-end')).toBe(false);
        expect(historical.some((envelope) => envelope.role === 'agent' && envelope.ev.t === 'text')).toBe(false);
        expect(liveUser.id).toBe(historicalUser?.id);
    });

    it('uses the same stable ID for untitled live and historical reasoning text', () => {
        const live = mapCodexProcessorMessageToSessionEnvelopes({
            type: 'reasoning',
            message: 'inspect the edge case',
            id: 'live-reasoning-random-id',
        }, {
            currentTurnId: 'turn-reasoning-1',
            textEnvelopeOccurrences: new Map<string, number>(),
        })[0];
        const historical = mapCodexThreadToSessionEnvelopes({
            turns: [{
                id: 'turn-reasoning-1',
                items: [{
                    id: 'history-reasoning-item',
                    type: 'reasoning',
                    summary: ['inspect the edge case'],
                    content: [],
                }],
            }],
        }).find((envelope) => envelope.ev.t === 'text' && envelope.ev.thinking === true);

        expect(live.id).toBe(historical?.id);
        expect(live.codexItemId).not.toBe(historical?.codexItemId);
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
