import { describe, expect, it } from 'vitest';
import type { Message, ToolCallMessage } from '@/sync/typesMessage';
import { collectConversationActivities, getSkillNamesFromTool } from './conversationActivity';
import { getEffectiveToolName, getSkillDocumentName } from './toolIdentity';

function toolMessage(
    id: number,
    name: string,
    input: unknown,
    state: ToolCallMessage['tool']['state'] = 'completed',
    children: Message[] = [],
): ToolCallMessage {
    return {
        kind: 'tool-call',
        id: String(id),
        localId: null,
        createdAt: id,
        tool: {
            name,
            input,
            state,
            createdAt: id,
            startedAt: id,
            completedAt: state === 'running' ? null : id,
            description: null,
        },
        children,
    };
}

describe('Claude Skill document reads', () => {
    it('recognizes agy Path arguments and historical single file locations as document loads', () => {
        for (const input of [
            { Path: '/skills/ego-browser/SKILL.md' },
            { locations: [{ path: '/skills/ego-browser/SKILL.md' }] },
        ]) {
            const message = toolMessage(1, 'read', input);
            expect(collectConversationActivities([message]).skills).toEqual([
                expect.objectContaining({ name: 'ego-browser', source: 'document-read', status: 'completed' }),
            ]);
        }
    });

    it('does not infer an agy Skill from ambiguous locations or a non-read operation', () => {
        expect(getSkillDocumentName(toolMessage(1, 'read', { locations: [
            { path: '/skills/one/SKILL.md' }, { path: '/skills/two/SKILL.md' },
        ] }).tool)).toBeNull();
        expect(getSkillNamesFromTool(toolMessage(1, 'edit', { Path: '/skills/ego-ops/SKILL.md' }).tool)).toEqual([]);
    });

    it('recognizes an agy command only when it exclusively reads Skill documents', () => {
        expect(collectConversationActivities([toolMessage(1, 'execute', { CommandLine: "cat '/skills/ego-ops/SKILL.md'" })]).skills)
            .toEqual([expect.objectContaining({ name: 'ego-ops', source: 'command-read' })]);
        expect(getSkillNamesFromTool(toolMessage(2, 'execute', { CommandLine: "cat '/skills/ego-ops/SKILL.md' && rm file" }).tool)).toEqual([]);
    });
    it.each([
        ['/Users/example/jacky-skills/skills/photo-to-styled-motion/SKILL.md', 'photo-to-styled-motion'],
        ['/Volumes/External Drive/project/.agents/skills/grade-images/SKILL.md', 'grade-images'],
        ['.claude/skills/local-style/SKILL.md', 'local-style'],
        ['local-style/SKILL.md', 'local-style'],
        ['C:\\Users\\example\\.claude\\skills\\local-style\\SKILL.md', 'local-style'],
    ])('recognizes an exact Skill document at %s without rewriting Read', (filePath, expected) => {
        const message = toolMessage(1, 'Read', { file_path: filePath });
        expect(getSkillDocumentName(message.tool)).toBe(expected);
        expect(getSkillNamesFromTool(message.tool)).toEqual([expected]);
        expect(getEffectiveToolName(message.tool)).toBe('Read');
        expect(message.tool.name).toBe('Read');
    });

    it('supports the normalized path field on a historical Read', () => {
        expect(getSkillDocumentName(toolMessage(1, 'Read', {
            path: '/skills/photo-to-styled-motion/SKILL.md',
        }).tool)).toBe('photo-to-styled-motion');
    });

    it.each([
        '/skills/local-style/README.md',
        '/skills/local-style/skill.md',
        '/skills/local-style/SKILL.md.bak',
        '/skills/local-style/SKILL.md/notes.md',
        '/skills/local-style/SKILL.md/',
        '/SKILL.md',
        'SKILL.md',
        './SKILL.md',
        '../SKILL.md',
        '',
    ])('does not report an ordinary or ambiguous file as a Skill: %s', (filePath) => {
        const message = toolMessage(1, 'Read', { file_path: filePath });
        expect(getSkillDocumentName(message.tool)).toBeNull();
        expect(getSkillNamesFromTool(message.tool)).toEqual([]);
        expect(collectConversationActivities([message]).skills).toEqual([]);
    });

    it.each([null, undefined, {}, { file_path: 42 }, { file_path: [] }, { file_path: {} }])(
        'ignores malformed Read arguments without throwing: %j', (input) => {
            const message = toolMessage(1, 'Read', input);
            expect(getSkillDocumentName(message.tool)).toBeNull();
            expect(getSkillNamesFromTool(message.tool)).toEqual([]);
        },
    );

    it.each(['Write', 'Edit', 'Bash', 'Grep'])('does not infer a document read from %s', (name) => {
        const message = toolMessage(1, name, { file_path: '/skills/local-style/SKILL.md' });
        expect(getSkillDocumentName(message.tool)).toBeNull();
        expect(getSkillNamesFromTool(message.tool)).toEqual([]);
    });

    it('does not trust Skill metadata on an ordinary Read', () => {
        expect(getSkillNamesFromTool(toolMessage(1, 'Read', {
            file_path: '/repo/README.md',
            skill: 'local-style',
            skillNames: ['local-style'],
        }).tool)).toEqual([]);
    });

    it('groups repeated document reads separately from a native invocation of the same Skill', () => {
        const first = toolMessage(1, 'Read', { file_path: '/skills/local-style/SKILL.md' });
        const native = toolMessage(2, 'Skill', { skill: 'local-style' });
        const repeated = toolMessage(3, 'Read', { file_path: '/skills/local-style/SKILL.md' });

        const activities = collectConversationActivities([first, native, repeated]).skills;
        expect(activities).toHaveLength(2);
        expect(activities.find(activity => activity.source === 'document-read')).toMatchObject({
            name: 'local-style',
            source: 'document-read',
            status: 'completed',
            invocationMessageIds: ['1', '3'],
        });
        expect(activities.find(activity => activity.source !== 'document-read')).toMatchObject({
            name: 'local-style',
            status: 'completed',
            invocationMessageIds: ['2'],
        });
        expect(new Set(activities.map(activity => activity.id)).size).toBe(2);
    });

    it('keeps identical Skill reads in separate subagent ownership scopes', () => {
        const rootRead = toolMessage(1, 'Read', { file_path: '/skills/local-style/SKILL.md' });
        const childRead = toolMessage(3, 'Read', { file_path: '/skills/local-style/SKILL.md' });
        const agent = toolMessage(2, 'Agent', { sessionSubagent: 'child-agent' }, 'completed', [childRead]);

        const activities = collectConversationActivities([rootRead, agent]).skills;
        expect(activities).toHaveLength(2);
        expect(activities.map(activity => activity.depth)).toEqual([0, 1]);
        expect(activities.map(activity => activity.invocationMessageIds)).toEqual([['1'], ['3']]);
    });

    it.each([
        ['running', 'running'],
        ['completed', 'completed'],
        ['error', 'failed'],
        ['cancelled', 'cancelled'],
    ] as const)('retains the %s document load state', (state, expected) => {
        const message = toolMessage(1, 'Read', { file_path: '/skills/local-style/SKILL.md' }, state);
        expect(collectConversationActivities([message]).skills[0]).toMatchObject({
            name: 'local-style', source: 'document-read', status: expected,
        });
    });

    it('waits for Read permission before exposing a document-load activity in group summaries', () => {
        const message = toolMessage(1, 'Read', { file_path: '/skills/local-style/SKILL.md' }, 'running');
        message.tool.permission = { id: 'read-permission', status: 'pending' };
        expect(collectConversationActivities([message]).skills).toEqual([]);
        expect(getEffectiveToolName(message.tool)).toBe('Read');

        message.tool.permission.status = 'approved';
        expect(collectConversationActivities([message]).skills).toEqual([
            expect.objectContaining({ name: 'local-style', source: 'document-read', status: 'running' }),
        ]);
    });

    it('retains a failed Read diagnostic and does not replace native invocation success', () => {
        const native = toolMessage(1, 'Skill', { skill: 'local-style' });
        const failedRead = toolMessage(2, 'Read', { file_path: '/skills/local-style/SKILL.md' }, 'error');
        failedRead.tool.failure = {
            summary: 'Skill document could not be read.',
            detail: 'Permission denied: /skills/local-style/SKILL.md',
        };

        const activities = collectConversationActivities([native, failedRead]).skills;
        expect(activities).toHaveLength(2);
        expect(activities.find(activity => activity.source === 'document-read')).toMatchObject({
            status: 'failed', failure: failedRead.tool.failure,
        });
        expect(activities.find(activity => activity.source !== 'document-read')?.status).toBe('completed');
    });
});
