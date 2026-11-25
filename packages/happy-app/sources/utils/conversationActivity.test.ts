import { describe, expect, it } from 'vitest';
import { Message, ToolCallMessage } from '@/sync/typesMessage';
import {
    collectConversationActivities,
    findSubagentTranscript,
    getSkillNamesFromTool,
} from './conversationActivity';

function toolMessage(
    id: string,
    name: string,
    input: Record<string, unknown>,
    state: ToolCallMessage['tool']['state'] = 'completed',
    children: Message[] = [],
): ToolCallMessage {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: Number(id.replace(/\D/g, '')) || 1,
        tool: {
            name,
            input,
            state,
            createdAt: 1,
            startedAt: 1,
            completedAt: state === 'running' ? null : 2,
            description: null,
        },
        children,
    };
}

describe('conversation activity model', () => {
    it('repairs a generic historical summary using the real diagnostic', () => {
        const skill = toolMessage('1', 'Skill', { skillNames: ['dev'] }, 'error');
        skill.tool.failure = { summary: 'Command exited with code 1.' };
        skill.tool.result = '---\nname: dev\n---\n' + 'instructions\n'.repeat(600) + 'ls: /missing: No such file or directory';
        expect(collectConversationActivities([skill]).skills[0].failure).toMatchObject({
            summary: 'ls: /missing: No such file or directory',
            detail: expect.stringContaining('ls: /missing: No such file or directory'),
        });
    });
    it('does not attribute a mixed historical terminal failure to the Skill', () => {
        const mixed = toolMessage('1', 'Skill', {
            skillNames: ['release-ops'], command: 'cat /skills/release-ops/SKILL.md; ls /missing',
        }, 'error');
        expect(getSkillNamesFromTool(mixed.tool)).toEqual([]);
        expect(collectConversationActivities([mixed]).skills).toEqual([
            expect.objectContaining({
                name: 'release-ops', source: 'command-read', status: 'failed', failure: null,
            }),
        ]);
    });

    it('extracts native and normalized Skill names', () => {
        expect(getSkillNamesFromTool(toolMessage('1', 'Skill', {
            skillNames: ['dev', 'obsidian-tools:ob-chat'],
            skill: 'dev',
        }).tool)).toEqual(['dev', 'obsidian-tools:ob-chat']);
    });

    it.each(['running', 'completed', 'error'] as const)('keeps a batch %s status on the command, not on each named Skill', (state) => {
        const batch = toolMessage('1', 'Skill', { skillNames: ['dev', 'workflow', 'tdd'] }, state);
        const activities = collectConversationActivities([batch]).skills;
        expect(activities).toHaveLength(1);
        expect(activities[0]).toMatchObject({
            name: 'dev, workflow, tdd',
            isBatch: true,
            status: state === 'error' ? 'failed' : state,
        });
    });

    it('keeps batch identity across replayed message IDs but separates distinct calls', () => {
        const original = toolMessage('1', 'Skill', { skillNames: ['dev', 'tdd'] });
        const withCallId = { ...original, tool: { ...original.tool, callId: 'batch-call' } };
        const replayed = { ...withCallId, id: 'replayed-1' };
        const other = { ...original, id: '2', tool: { ...original.tool, callId: 'other-call' } };
        const first = collectConversationActivities([withCallId]).skills[0];
        expect(collectConversationActivities([replayed]).skills[0].id).toBe(first.id);
        const skills = collectConversationActivities([replayed, other]).skills;
        expect(new Set(skills.map(skill => skill.id)).size).toBe(2);
    });

    it('keeps an individual retry separate from its failed batch', () => {
        const batch = toolMessage('1', 'Skill', { skillNames: ['dev', 'workflow'] }, 'error');
        const retry = toolMessage('2', 'Skill', { skillName: 'workflow' });
        expect(collectConversationActivities([batch, retry]).skills).toEqual([
            expect.objectContaining({ name: 'dev, workflow', status: 'failed', isBatch: true }),
            expect.objectContaining({ name: 'workflow', status: 'completed' }),
        ]);
    });

    it('does not overwrite a confirmed individual success with a later batch failure', () => {
        const loaded = toolMessage('1', 'Skill', { skillName: 'dev' });
        const batch = toolMessage('2', 'Skill', { skillNames: ['dev', 'workflow'] }, 'error');
        expect(collectConversationActivities([loaded, batch]).skills).toEqual([
            expect.objectContaining({ name: 'dev', status: 'completed' }),
            expect.objectContaining({ name: 'dev, workflow', status: 'failed', isBatch: true }),
        ]);
    });

    it('finds a legacy diagnostic after long Skill content before truncating the detail', () => {
        const batch = toolMessage('1', 'Skill', { skillNames: ['dev', 'workflow'] }, 'error');
        const diagnostic = 'sed: /skills/workflow/SKILL.md: No such file or directory';
        batch.tool.result = '---\nname: dev\n---\n' + 'Skill instructions\n'.repeat(400) + diagnostic;
        const activity = collectConversationActivities([batch]).skills[0];
        expect(activity.failure?.summary).toBe(diagnostic);
        expect(activity.failure?.detail?.length).toBeLessThanOrEqual(4000);
        expect(activity.failure?.detail).toContain(diagnostic);
    });

    it('repairs a frontmatter-only summary using retained command output', () => {
        const batch = toolMessage('1', 'Skill', { skillNames: ['dev', 'workflow'] }, 'error');
        batch.tool.failure = { summary: '---', detail: '---\nname: dev\n---' };
        batch.children.push({
            kind: 'agent-text', id: 'output', localId: null, createdAt: 2, isThinking: true,
            text: '---\nname: dev\n---\nsed: /skills/workflow/SKILL.md: Permission denied',
        });
        expect(collectConversationActivities([batch]).skills[0].failure?.summary)
            .toBe('sed: /skills/workflow/SKILL.md: Permission denied');
    });

    it('keeps a subagent running until its lifecycle stop arrives', () => {
        const start: Message = {
            kind: 'agent-event',
            id: '2',
            createdAt: 2,
            event: {
                type: 'subagent-status',
                subagent: 'agent-1',
                title: 'UI reviewer',
                status: 'running',
            },
        };
        const agent = toolMessage('1', 'Agent', {
            sessionSubagent: 'agent-1',
            prompt: 'Review the UI',
        }, 'completed', [start]);

        expect(collectConversationActivities([agent]).subagents).toEqual([
            expect.objectContaining({ id: 'agent-1', title: 'UI reviewer', status: 'running' }),
        ]);

        agent.children.push({
            kind: 'agent-event',
            id: '3',
            createdAt: 3,
            event: {
                type: 'subagent-status',
                subagent: 'agent-1',
                status: 'failed',
            },
        });

        expect(collectConversationActivities([agent]).subagents).toEqual([
            expect.objectContaining({ id: 'agent-1', title: 'UI reviewer', status: 'failed' }),
        ]);
    });

    it('collects Skill activity recursively from subagents', () => {
        const skill = toolMessage('2', 'Skill', { skillNames: ['dev'] }, 'running');
        const agent = toolMessage('1', 'Agent', { sessionSubagent: 'agent-1' }, 'completed', [skill]);

        expect(collectConversationActivities([agent]).skills).toEqual([
            expect.objectContaining({ name: 'dev', status: 'running', depth: 1 }),
        ]);
    });

    it('keeps the diagnostic information for a failed Skill activity', () => {
        const skill = toolMessage('1', 'Skill', { skillNames: ['gpt-image-2'] }, 'error');
        skill.tool.failure = {
            code: 'command_failed',
            summary: 'Skill file was not found.',
            detail: 'sed: /plugins/gpt-image-2/SKILL.md: No such file or directory',
        };

        expect(collectConversationActivities([skill]).skills).toEqual([
            expect.objectContaining({
                name: 'gpt-image-2',
                status: 'failed',
                failure: skill.tool.failure,
            }),
        ]);
    });

    it('uses a legacy tool result as the failed Skill diagnostic when structured data is absent', () => {
        const skill = toolMessage('1', 'Skill', { skillNames: ['legacy-skill'] }, 'error');
        skill.tool.result = 'Cannot read SKILL.md\nPermission denied';

        expect(collectConversationActivities([skill]).skills).toEqual([
            expect.objectContaining({
                name: 'legacy-skill',
                failure: {
                    summary: 'Cannot read SKILL.md',
                    detail: 'Cannot read SKILL.md\nPermission denied',
                },
            }),
        ]);
    });

    it('preserves nested subagent ownership depth without flattening', () => {
        const nestedAgent = toolMessage('2', 'Agent', {
            sessionSubagent: 'agent-2',
            description: 'Nested reviewer',
        }, 'completed', [{
            kind: 'agent-event',
            id: 'nested-start',
            createdAt: 3,
            event: {
                type: 'subagent-status',
                subagent: 'agent-2',
                status: 'running',
            },
        }]);
        const rootAgent = toolMessage('1', 'Agent', {
            sessionSubagent: 'agent-1',
            description: 'Implementation agent',
        }, 'completed', [
            {
                kind: 'agent-event',
                id: 'root-start',
                createdAt: 2,
                event: {
                    type: 'subagent-status',
                    subagent: 'agent-1',
                    status: 'running',
                },
            },
            nestedAgent,
        ]);

        expect(collectConversationActivities([rootAgent]).subagents).toEqual([
            expect.objectContaining({ id: 'agent-1', depth: 0 }),
            expect.objectContaining({ id: 'agent-2', depth: 1 }),
        ]);
        expect(collectConversationActivities(rootAgent.children, { rootSubagentId: 'agent-1' }).subagents).toEqual([
            expect.objectContaining({ id: 'agent-1', depth: 0 }),
            expect.objectContaining({ id: 'agent-2', depth: 1 }),
        ]);
    });
});

describe('subagent display data', () => {
    it('shows a running child command and the explicitly requested agent mode', () => {
        const active = toolMessage('20', 'CodexBash', {
            parsed_cmd: [{ cmd: 'pnpm --filter happy-app test' }],
        }, 'running');
        active.tool.startedAt = 20;
        const finished = toolMessage('30', 'Read', { file_path: 'README.md' });
        finished.tool.completedAt = 30;
        const agent = toolMessage('10', 'Agent', {
            sessionSubagent: 'agent-live', model: 'gpt-6.1-sol', reasoningEffort: 'ultra', provider: 'codex',
        }, 'running', [active, finished]);
        agent.tool.startedAt = 10;

        expect(collectConversationActivities([agent]).subagents[0]).toMatchObject({
            id: 'agent-live', startedAt: 10, completedAt: null,
            currentAction: 'pnpm --filter happy-app test', model: 'gpt-6.1-sol', effort: 'ultra', provider: 'codex',
        });
    });

    it('freezes the lifecycle completion time and ignores a late-arriving older running event', () => {
        const status = (id: string, at: number, value: 'running' | 'completed'): Message => ({
            kind: 'agent-event', id, createdAt: at,
            event: { type: 'subagent-status', subagent: 'agent-finished', status: value },
        });
        const command = toolMessage('40', 'Bash', { command: 'pnpm test' });
        command.tool.completedAt = 45;
        const agent = toolMessage('10', 'Agent', { sessionSubagent: 'agent-finished' }, 'completed', [
            status('start', 11, 'running'), command, status('stop', 80, 'completed'), status('late-start', 20, 'running'),
        ]);
        agent.tool.startedAt = 10;
        agent.tool.completedAt = 12; // Returning from spawn is not the agent's stop.

        expect(collectConversationActivities([agent]).subagents[0]).toMatchObject({
            status: 'completed', startedAt: 10, completedAt: 80, updatedAt: 80, currentAction: 'pnpm test',
        });
        const noLifecycle = toolMessage('90', 'Task', { sessionSubagent: 'task-finished' });
        noLifecycle.tool.startedAt = null;
        noLifecycle.tool.createdAt = 90;
        noLifecycle.tool.completedAt = 100;
        expect(collectConversationActivities([noLifecycle]).subagents[0]).toMatchObject({ startedAt: 90, completedAt: 100 });
    });

    it('does not turn parent message metadata or a model name into unknown subagent mode facts', () => {
        const command = toolMessage('20', 'Bash', { command: 'rg node src' });
        command.meta = { model: 'parent-model', effort: 'high' };
        const agent = toolMessage('10', 'Agent', { sessionSubagent: 'agent-unknown' }, 'running', [command]);
        agent.meta = { model: 'parent-model', effort: 'high' };
        expect(collectConversationActivities([agent]).subagents[0]).toMatchObject({ model: null, effort: null, provider: null });

        agent.tool.input.model = 'gpt-6.1-sol';
        expect(collectConversationActivities([agent]).subagents[0]).toMatchObject({ model: 'gpt-6.1-sol', provider: null });
    });

    it('keeps nested agent actions in their own rows while retaining ownership depth and order', () => {
        const ownCommand = toolMessage('20', 'Bash', { command: 'rg publish server/app' });
        ownCommand.tool.completedAt = 20;
        const nestedCommand = toolMessage('40', 'Bash', { command: 'node --test test/reviewer.test.js' }, 'running');
        nestedCommand.tool.startedAt = 40;
        const nested = toolMessage('30', 'Agent', { sessionSubagent: 'agent-nested', model: 'review-model' }, 'running', [nestedCommand]);
        const root = toolMessage('10', 'Agent', { sessionSubagent: 'agent-root' }, 'running', [ownCommand, nested]);

        expect(collectConversationActivities([root]).subagents).toEqual([
            expect.objectContaining({ id: 'agent-root', depth: 0, order: 1, currentAction: 'rg publish server/app', model: null }),
            expect.objectContaining({ id: 'agent-nested', depth: 1, order: 3, currentAction: 'node --test test/reviewer.test.js', model: 'review-model' }),
        ]);
    });

    it('retains the last real command and its failure summary for a failed agent', () => {
        const command = toolMessage('20', 'Bash', { command: 'node --test test/publish.test.js' }, 'error');
        command.tool.failure = { summary: 'Expected createPublish to be exported.' };
        const agent = toolMessage('10', 'Agent', { sessionSubagent: 'agent-failed' }, 'completed', [command, {
            kind: 'agent-event', id: 'stop', createdAt: 30,
            event: { type: 'subagent-status', subagent: 'agent-failed', status: 'failed' },
        }]);

        expect(collectConversationActivities([agent]).subagents[0]).toMatchObject({
            status: 'failed', completedAt: 30, currentAction: 'node --test test/publish.test.js',
            failureSummary: 'Expected createPublish to be exported.',
        });
    });

    it('retains real lifetime and display data when a later Agent call addresses the same subagent', () => {
        const command = toolMessage('20', 'Bash', { command: 'pnpm test' }, 'running');
        command.tool.startedAt = 20;
        const spawn = toolMessage('10', 'Agent', { sessionSubagent: 'agent-one', model: 'test-model' }, 'completed', [command]);
        spawn.tool.startedAt = 10;
        const sendInput = toolMessage('30', 'Agent', { sessionSubagent: 'agent-one', tool: 'sendInput' }, 'completed');
        sendInput.tool.startedAt = 30;
        const activities = collectConversationActivities([spawn, sendInput]).subagents;

        expect(activities).toHaveLength(1);
        expect(activities[0]).toMatchObject({ id: 'agent-one', startedAt: 10, model: 'test-model', currentAction: 'pnpm test' });
    });

    it('uses the new child failure after a failed start is successfully resumed', () => {
        const first = toolMessage('10', 'Agent', { sessionSubagent: 'agent-recovered' }, 'error');
        first.tool.startedAt = 10;
        first.tool.completedAt = 20;
        first.tool.failure = { summary: 'Initial agent startup failed.' };
        const command = toolMessage('40', 'Bash', { command: 'pnpm test' }, 'error');
        command.tool.startedAt = 40;
        command.tool.completedAt = 50;
        command.tool.failure = { summary: 'Current test assertion failed.' };
        const resumed = toolMessage('30', 'Agent', { sessionSubagent: 'agent-recovered', tool: 'resume' }, 'completed', [command, {
            kind: 'agent-event', id: 'resumed', createdAt: 31,
            event: { type: 'subagent-status', subagent: 'agent-recovered', status: 'running' },
        }, {
            kind: 'agent-event', id: 'failed', createdAt: 60,
            event: { type: 'subagent-status', subagent: 'agent-recovered', status: 'failed' },
        }]);
        resumed.tool.startedAt = 30;
        resumed.tool.completedAt = 32;

        expect(collectConversationActivities([first, resumed]).subagents[0]).toMatchObject({
            status: 'failed', currentAction: 'pnpm test', failureSummary: 'Current test assertion failed.',
        });

        resumed.tool.state = 'error';
        resumed.tool.failure = { summary: 'Resume failed before the command finished.' };
        resumed.tool.completedAt = 45;
        expect(collectConversationActivities([first, resumed]).subagents[0].failureSummary).toBe('Current test assertion failed.');
        resumed.tool.completedAt = 55;
        expect(collectConversationActivities([first, resumed]).subagents[0].failureSummary).toBe('Resume failed before the command finished.');
    });

    it('does not reuse a child error from before the current lifecycle resumed', () => {
        const command = toolMessage('20', 'Bash', { command: 'pnpm test' }, 'error');
        command.tool.completedAt = 25;
        command.tool.failure = { summary: 'Old test failure.' };
        const agent = toolMessage('10', 'Agent', { sessionSubagent: 'agent-resumed' }, 'completed', [command, {
            kind: 'agent-event', id: 'resumed', createdAt: 30,
            event: { type: 'subagent-status', subagent: 'agent-resumed', status: 'running' },
        }, {
            kind: 'agent-event', id: 'failed', createdAt: 40,
            event: { type: 'subagent-status', subagent: 'agent-resumed', status: 'failed' },
        }]);

        expect(collectConversationActivities([agent]).subagents[0].failureSummary).toBeNull();
    });

    it('retains the current lifecycle failure after a successful cleanup command', () => {
        const failed = toolMessage('20', 'Bash', { command: 'pnpm test' }, 'error');
        failed.tool.startedAt = 20;
        failed.tool.completedAt = 30;
        failed.tool.failure = { summary: 'Publish test assertion failed.' };
        const cleanup = toolMessage('40', 'Bash', { command: 'node scripts/cleanup-test-fixtures.js' });
        cleanup.tool.startedAt = 40;
        cleanup.tool.completedAt = 50;
        const agent = toolMessage('10', 'Agent', { sessionSubagent: 'agent-cleaned' }, 'completed', [{
            kind: 'agent-event', id: 'started', createdAt: 11,
            event: { type: 'subagent-status', subagent: 'agent-cleaned', status: 'running' },
        }, failed, cleanup, {
            kind: 'agent-event', id: 'failed', createdAt: 60,
            event: { type: 'subagent-status', subagent: 'agent-cleaned', status: 'failed' },
        }]);

        expect(collectConversationActivities([agent]).subagents[0]).toMatchObject({
            currentAction: 'node scripts/cleanup-test-fixtures.js',
            failureSummary: 'Publish test assertion failed.', status: 'failed',
        });
    });
});

describe('subagent transcript lookup', () => {
    it('returns a direct subagent transcript in chronological order', () => {
        const later: Message = {
            kind: 'agent-text',
            id: 'later',
            localId: null,
            createdAt: 30,
            text: 'Done',
        };
        const earlier = toolMessage('10', 'Bash', { command: 'pnpm test' });
        const agent = toolMessage('1', 'Agent', {
            sessionSubagent: 'agent-direct',
            description: 'Implementation agent',
        }, 'completed', [later, earlier]);

        expect(findSubagentTranscript([agent], 'agent-direct')).toEqual({
            agent,
            messages: [earlier, later],
        });
    });

    it('finds a nested subagent without leaking its parent transcript', () => {
        const nestedText: Message = {
            kind: 'agent-text',
            id: 'nested-text',
            localId: null,
            createdAt: 4,
            text: 'Nested result',
        };
        const nestedAgent = toolMessage('3', 'Agent', {
            sessionSubagent: 'agent-nested',
            title: 'Reviewer',
        }, 'completed', [nestedText]);
        const parentText: Message = {
            kind: 'agent-text',
            id: 'parent-text',
            localId: null,
            createdAt: 2,
            text: 'Parent-only result',
        };
        const parentAgent = toolMessage('1', 'Agent', {
            sessionSubagent: 'agent-parent',
            title: 'Reviewer',
        }, 'completed', [parentText, nestedAgent]);

        expect(findSubagentTranscript([parentAgent], 'agent-nested')).toEqual({
            agent: nestedAgent,
            messages: [nestedText],
        });
    });

    it('omits the selected agent own status row while preserving nested agents', () => {
        const ownStatus: Message = {
            kind: 'agent-event',
            id: 'agent-target-status',
            createdAt: 2,
            event: {
                type: 'subagent-status',
                subagent: 'agent-target',
                title: 'Implementation agent',
                status: 'running',
            },
        };
        const nestedStatus: Message = {
            kind: 'agent-event',
            id: 'agent-nested-status',
            createdAt: 4,
            event: {
                type: 'subagent-status',
                subagent: 'agent-nested',
                title: 'Review agent',
                status: 'completed',
            },
        };
        const nestedAgent = toolMessage('3', 'Agent', {
            sessionSubagent: 'agent-nested',
            title: 'Review agent',
        }, 'completed', [nestedStatus]);
        const targetAgent = toolMessage('1', 'Agent', {
            sessionSubagent: 'agent-target',
            title: 'Implementation agent',
        }, 'completed', [ownStatus, nestedAgent]);

        expect(findSubagentTranscript([targetAgent], 'agent-target')?.messages).toEqual([nestedAgent]);
        expect(findSubagentTranscript([targetAgent], 'agent-nested')?.messages).toEqual([]);
    });

    it('omits hidden reasoning while retaining visible agent text', () => {
        const reasoning: Message = {
            kind: 'agent-text',
            id: 'agent-reasoning',
            localId: null,
            createdAt: 2,
            text: 'Private chain of thought',
            isThinking: true,
        };
        const visible: Message = {
            kind: 'agent-text',
            id: 'agent-visible',
            localId: null,
            createdAt: 3,
            text: 'Visible summary',
        };
        const targetAgent = toolMessage('1', 'Agent', {
            sessionSubagent: 'agent-target',
        }, 'completed', [reasoning, visible]);

        expect(findSubagentTranscript([targetAgent], 'agent-target')?.messages).toEqual([visible]);
    });

    it('matches sessionSubagent rather than a shared title', () => {
        const first = toolMessage('1', 'Agent', {
            sessionSubagent: 'agent-one',
            title: 'Reviewer',
        }, 'completed', []);
        const second = toolMessage('2', 'Agent', {
            sessionSubagent: 'agent-two',
            title: 'Reviewer',
        }, 'completed', []);

        expect(findSubagentTranscript([first, second], 'agent-two')?.agent).toBe(second);
        expect(findSubagentTranscript([first, second], 'missing-agent')).toBeNull();
    });
});
