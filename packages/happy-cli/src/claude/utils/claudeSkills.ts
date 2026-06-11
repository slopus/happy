import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SKILL_FILE = 'SKILL.md';

export async function discoverClaudeSkills(workingDirectory: string): Promise<string[]> {
    const skillsRoot = join(workingDirectory, '.claude', 'skills');
    let entries: Array<{ name: { toString(): string } }>;
    try {
        entries = await readdir(skillsRoot, { withFileTypes: true });
    } catch {
        return [];
    }

    const names = new Set<string>();
    await Promise.all(entries.map(async (entry) => {
        const entryName = entry.name.toString();
        if (entryName.startsWith('.')) {
            return;
        }
        const skillFile = join(skillsRoot, entryName, SKILL_FILE);
        const skillName = await readSkillName(skillFile, entryName);
        if (skillName) {
            names.add(skillName);
        }
    }));

    return [...names].sort((a, b) => a.localeCompare(b));
}

async function readSkillName(skillFile: string, fallbackName: string): Promise<string | null> {
    let content: string;
    try {
        content = await readFile(skillFile, 'utf8');
    } catch {
        return null;
    }

    const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---/);
    const name = frontmatter?.[1].match(/^name:\s*["']?([^"'\n]+?)["']?\s*$/m)?.[1] ?? fallbackName;
    const normalized = name.trim().replace(/^\/+/, '');
    return normalized.length > 0 ? normalized : null;
}
