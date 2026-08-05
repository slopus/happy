import { describe, expect, it } from 'vitest';
import { Message, ToolCallMessage } from '@/sync/typesMessage';
import { collectConversationActivities, getSkillNamesFromTool } from './conversationActivity';

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
