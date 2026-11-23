import { describe, expect, it } from 'vitest';
import type { Message, ToolCallMessage } from '@/sync/typesMessage';
import { collectConversationActivities, getSkillNamesFromTool } from './conversationActivity';
import { getEffectiveToolName } from './toolIdentity';

function commandMessage(
    id: number,
    command: unknown,
    name = 'CodexBash',
    state: ToolCallMessage['tool']['state'] = 'completed',
): ToolCallMessage {
    return {
        kind: 'tool-call', id: String(id), localId: null, createdAt: id, children: [],
        tool: {
            name, input: { command }, state, createdAt: id, startedAt: id,
            completedAt: state === 'running' ? null : id, description: null,
        },
    };
}

describe('Skill reads retained inside terminal commands', () => {
    it('includes a Claude Bash Skill read without changing its original tool identity', () => {
        const message = commandMessage(1, 'cat /Users/example/skills/photo-to-styled-motion/SKILL.md', 'Bash');
        expect(collectConversationActivities([message]).skills).toEqual([
            expect.objectContaining({ name: 'photo-to-styled-motion', source: 'command-read', status: 'completed', failure: null }),
        ]);
        expect(getEffectiveToolName(message.tool)).toBe('Bash');
        expect(getSkillNamesFromTool(message.tool)).toEqual([]);
    });

    it('includes independent Skill readers from a mixed shell-wrapper array in source order', () => {
        const message = commandMessage(1, ['/bin/zsh', '-lc', [
            'git status --short',
            'cat "/Users/example/skills/codex-harness/SKILL.md"',
            'cat "/Users/example/skills/release-ops/SKILL.md"',
        ].join('\n')]);
        expect(collectConversationActivities([message]).skills).toEqual([
            expect.objectContaining({ name: 'codex-harness, release-ops', source: 'command-read', isBatch: true, failure: null }),
        ]);
        expect(getEffectiveToolName(message.tool)).toBe('CodexBash');
    });

    it('recognizes a retained string shell wrapper', () => {
        const command = '/bin/zsh -lc \'git status --short; cat "/skills/release-ops/SKILL.md"\'';
        expect(collectConversationActivities([commandMessage(1, command)]).skills).toEqual([
            expect.objectContaining({ name: 'release-ops', source: 'command-read' }),
        ]);
    });

    it('ignores cat examples in comments and strings while retaining a separate real reader', () => {
        const command = [
            '# cat /skills/comment-example/SKILL.md',
            'printf "%s" "cat /skills/string-example/SKILL.md"',
            'cat /skills/real-reader/SKILL.md # cat /skills/trailing-example/SKILL.md',
        ].join('\n');
        expect(collectConversationActivities([commandMessage(1, command)]).skills).toEqual([
            expect.objectContaining({ name: 'real-reader', source: 'command-read' }),
        ]);
    });

    it('does not duplicate an existing normalized native Skill activity as a command read', () => {
        const message = commandMessage(1, 'cat /skills/ego-browser/SKILL.md', 'Skill');
        message.tool.input.skill = 'ego-browser';
        const activities = collectConversationActivities([message]).skills;
        expect(activities).toHaveLength(1);
        expect(activities[0]).toMatchObject({ name: 'ego-browser' });
        expect(activities[0].source).toBeUndefined();
    });

    it('recognizes three cat readers including an external-volume path with escaped spaces', () => {
        const command = String.raw`cat /Users/example/skills/ego-ops/SKILL.md
cat /Volumes/ZHITAI\ TiPlus7100s/Development/project/.agents/skills/sessions/SKILL.md
cat '/Users/example/skills/clear-and-brief-output/SKILL.md'`;
        expect(collectConversationActivities([commandMessage(1, ['/bin/zsh', '-lc', command])]).skills).toEqual([
            expect.objectContaining({ name: 'ego-ops, sessions, clear-and-brief-output', source: 'command-read', isBatch: true }),
        ]);
    });

    it('includes standard head and sed readers separated by unconditional semicolons', () => {
        const command = 'head -n 80 "/skills/first style/SKILL.md"; sed -n \'1,200p\' /skills/release-ops/SKILL.md';
        expect(collectConversationActivities([commandMessage(1, command)]).skills).toEqual([
            expect.objectContaining({ name: 'first style, release-ops', source: 'command-read', isBatch: true }),
        ]);
    });

    it('does not treat mentions, searches, writes or unevaluated shell text as Skill reads', () => {
        const excluded = [
            'echo "cat /skills/example/SKILL.md"',
            'grep pattern /skills/example/SKILL.md',
            'rg --files /skills/example/SKILL.md',
            'sed -i s/old/new/ /skills/example/SKILL.md',
            'echo text > /skills/example/SKILL.md',
            'printf "%s" "cat /skills/example/SKILL.md"',
            "cat <<'EOF'\ncat /skills/example/SKILL.md\nEOF",
            'cat /skills/example/SKILL.md | node process.js',
        ];
        for (const command of excluded) {
            expect(collectConversationActivities([commandMessage(1, command)]).skills, command).toEqual([]);
        }
    });

    it('does not claim a conditional reader ran when its shell branch may be skipped', () => {
        for (const command of [
            'false && cat /skills/example/SKILL.md',
            'true || cat /skills/example/SKILL.md',
            'if false; then cat /skills/example/SKILL.md; fi',
        ]) {
            expect(collectConversationActivities([commandMessage(1, command)]).skills, command).toEqual([]);
        }
    });

    it.each([
        ['running', 'running'],
        ['completed', 'completed'],
        ['error', 'failed'],
        ['cancelled', 'cancelled'],
    ] as const)('keeps the %s status on the command instead of inventing per-Skill load outcomes', (state, expected) => {
        const message = commandMessage(1, 'git status --short; cat /skills/release-ops/SKILL.md', 'CodexBash', state);
        message.tool.failure = { summary: 'git: repository unavailable', detail: 'Terminal command diagnostic' };
        expect(collectConversationActivities([message]).skills).toEqual([
            expect.objectContaining({ name: 'release-ops', source: 'command-read', status: expected, failure: null }),
        ]);
        expect(message.tool.failure.summary).toBe('git: repository unavailable');
    });

    it('keeps pending commands out of Skills until permission is approved', () => {
        const message = commandMessage(1, 'cat /skills/release-ops/SKILL.md', 'Bash', 'running');
        message.tool.permission = { id: 'permission-one', status: 'pending' };
        expect(collectConversationActivities([message]).skills).toEqual([]);
        message.tool.permission.status = 'approved';
        expect(collectConversationActivities([message]).skills).toEqual([
            expect.objectContaining({ name: 'release-ops', source: 'command-read', status: 'running' }),
        ]);
    });

    it('preserves subagent ownership for command reads of the same Skill', () => {
        const root = commandMessage(1, 'cat /skills/release-ops/SKILL.md');
        const child = commandMessage(3, 'cat /skills/release-ops/SKILL.md');
        const agent: ToolCallMessage = {
            ...commandMessage(2, undefined, 'Agent'),
            tool: { ...commandMessage(2, undefined, 'Agent').tool, input: { sessionSubagent: 'child-agent' } },
            children: [child] as Message[],
        };
        const activities = collectConversationActivities([root, agent]).skills;
        expect(activities).toHaveLength(2);
        expect(activities.map(activity => activity.depth)).toEqual([0, 1]);
        expect(activities.map(activity => activity.invocationMessageIds)).toEqual([['1'], ['3']]);
    });
});
