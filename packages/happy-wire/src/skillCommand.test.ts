import { describe, expect, it } from 'vitest';
import { extractSkillNamesFromCommand } from './skillCommand';

describe('pure Skill command classification', () => {
    it.each([
        'cat /skills/dev/SKILL.md',
        "sed -n '1,200p' /skills/dev/SKILL.md",
        'cat "/skills/dev/SKILL.md" && head -n 20 /skills/dev/SKILL.md',
        'Get-Content "C:\\Users\\a\\skills\\dev\\SKILL.md"',
    ])('recognizes a pure document read: %s', command => {
        expect(extractSkillNamesFromCommand(command)).toEqual(['dev']);
    });
    it.each([
        'cat /skills/dev/SKILL.md; ls /missing',
        'cat /skills/dev/SKILL.md /missing',
        'cat /skills/dev/SKILL.md | node script.js',
        'cat /skills/dev/SKILL.md > output',
        'cat "/skills/dev/SKILL.md',
        'sed -i -n 1,20p /skills/dev/SKILL.md',
        'echo "cat /skills/dev/SKILL.md"',
        'git diff -- /skills/dev/SKILL.md',
    ])('keeps mixed or unsupported commands terminal: %s', command => {
        expect(extractSkillNamesFromCommand(command)).toEqual([]);
    });
});
