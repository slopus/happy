import { describe, expect, it } from 'vitest';
import { getSkillCommandNames } from './skillCommandReads';

const tool = (command: string | string[]) => ({ name: 'CodexBash', input: { command } });

describe('unprovable shell reader execution', () => {
    it.each([
        'exit 0; cat /skills/never-read/SKILL.md',
        'exec true; cat /skills/never-read/SKILL.md',
        'return; cat /skills/never-read/SKILL.md',
        'set -e; false; cat /skills/never-read/SKILL.md',
        "alias cat='echo'; cat /skills/never-read/SKILL.md",
        '. ./setup.sh; cat /skills/never-read/SKILL.md',
        'eval setup; cat /skills/never-read/SKILL.md',
        'PATH=/untrusted; cat /skills/never-read/SKILL.md',
    ])('does not infer a read after shell control: %s', command => {
        expect(getSkillCommandNames(tool(command))).toEqual([]);
    });

    it('does not discard errexit semantics while unwrapping a shell', () => {
        expect(getSkillCommandNames(tool(['/bin/zsh', '-ec', 'false; cat /skills/never-read/SKILL.md']))).toEqual([]);
    });

    it.each([
        'cat /skills/*/SKILL.md',
        'cat /skills/dev?/SKILL.md',
        'cat /skills/[ab]/SKILL.md',
        'cat "/skills/foo\nbar/SKILL.md"',
    ])('does not invent an expanded or rewritten Skill name: %s', command => {
        expect(getSkillCommandNames(tool(command))).toEqual([]);
    });
});
