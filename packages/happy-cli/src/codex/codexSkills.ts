import { existsSync, readdirSync, readFileSync, realpathSync, statSync, type Dirent } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';

const MAX_SCAN_DEPTH = 10;

export function listCodexSkillNames(opts: {
    cwd?: string;
    homeDir?: string;
} = {}): string[] {
    const cwd = resolve(opts.cwd ?? process.cwd());
    const homeDir = resolve(opts.homeDir ?? os.homedir());
    const names = new Set<string>();

    for (const root of getSkillRoots(cwd, homeDir)) {
        for (const filePath of collectSkillFiles(root)) {
            const name = getSkillName(filePath);
            if (name) {
                names.add(name);
            }
        }
    }

    return [...names].sort((a, b) => a.localeCompare(b));
}

function getSkillRoots(cwd: string, homeDir: string): string[] {
    const seen = new Set<string>();
    const roots: string[] = [];

    const push = (path: string) => {
        const resolved = resolve(path);
        if (!seen.has(resolved)) {
            seen.add(resolved);
            roots.push(resolved);
        }
    };

    push(join(homeDir, '.codex', 'skills'));
    push(join(homeDir, '.agents', 'skills'));
    push(join(homeDir, '.codex', 'plugins'));

    for (const dir of getAncestorDirectories(cwd)) {
        push(join(dir, '.agents', 'skills'));
    }

    return roots;
}

function getAncestorDirectories(start: string): string[] {
    const dirs: string[] = [];
    let current = resolve(start);

    while (true) {
        dirs.push(current);
        const parent = dirname(current);
        if (parent === current) {
            break;
        }
        current = parent;
    }

    return dirs;
}

function collectSkillFiles(root: string): string[] {
    const files: string[] = [];
    const seenDirectories = new Set<string>();

    const visit = (dir: string, depth: number) => {
        if (depth > MAX_SCAN_DEPTH || !existsSync(dir)) {
            return;
        }

        let realDir: string;
        try {
            if (!statSync(dir).isDirectory()) {
                return;
            }
            realDir = realpathSync(dir);
        } catch {
            return;
        }

        if (seenDirectories.has(realDir)) {
            return;
        }
        seenDirectories.add(realDir);

        // A Skill's private state, dependencies and linked projects are not
        // additional catalog roots. Avoid even opening those directories.
        const skillFile = join(dir, 'SKILL.md');
        try {
            if (existsSync(skillFile) && statSync(skillFile).isFile()) {
                files.push(skillFile);
                return;
            }
        } catch {
            // Unreadable metadata does not prevent discovery of other Skills.
        }

        let entries: Dirent<string>[];
        try {
            entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' });
        } catch {
            return;
        }

        for (const entry of entries) {
            const fullPath = join(dir, entry.name);
            if (entry.name === 'SKILL.md') {
                files.push(fullPath);
                continue;
            }

            if (entry.isDirectory()) {
                visit(fullPath, depth + 1);
                continue;
            }

            if (!entry.isSymbolicLink()) {
                continue;
            }

            try {
                const stats = statSync(fullPath);
                if (stats.isDirectory()) {
                    visit(fullPath, depth + 1);
                } else if (stats.isFile() && entry.name === 'SKILL.md') {
                    files.push(fullPath);
                }
            } catch {
                // Ignore broken symlinks or unreadable entries.
            }
        }
    };

    visit(root, 0);
    return files;
}

function getSkillName(filePath: string): string | null {
    const skillDirName = dirname(filePath).split(/[\\/]/).pop();
    const baseName = readFrontmatterName(filePath) ?? skillDirName ?? null;
    if (!baseName) {
        return null;
    }

    const pluginName = getPluginName(filePath);
    return pluginName ? `${pluginName}:${baseName}` : baseName;
}

function readFrontmatterName(filePath: string): string | null {
    let contents: string;
    try {
        contents = readFileSync(filePath, 'utf8');
    } catch {
        return null;
    }

    if (!contents.startsWith('---')) {
        return null;
    }

    const end = contents.indexOf('\n---', 3);
    if (end === -1) {
        return null;
    }

    const frontmatter = contents.slice(0, end);
    const match = frontmatter.match(/^name:\s*(.+)$/m);
    if (!match) {
        return null;
    }

    const raw = match[1].trim();
    return raw.replace(/^['"]|['"]$/g, '') || null;
}

function getPluginName(filePath: string): string | null {
    const segments = filePath.split(/[\\/]/).filter(Boolean);
    const skillsIndex = segments.lastIndexOf('skills');
    if (skillsIndex === -1) {
        return null;
    }

    for (let index = skillsIndex - 1; index >= 0; index--) {
        if (segments[index] !== 'plugins') {
            continue;
        }

        if (segments[index + 1] === 'cache' && index + 3 < skillsIndex) {
            return segments[index + 3] || null;
        }

        if (index + 1 < skillsIndex) {
            return segments[index + 1] || null;
        }
    }

    return null;
}
