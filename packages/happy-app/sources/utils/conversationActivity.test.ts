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
    it('extracts native and normalized Skill names', () => {
        expect(getSkillNamesFromTool(toolMessage('1', 'Skill', {
            skillNames: ['dev', 'obsidian-tools:ob-chat'],
            skill: 'dev',
        }).tool)).toEqual(['dev', 'obsidian-tools:ob-chat']);
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
