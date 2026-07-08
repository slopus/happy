import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';

const SKILL_FILE = 'SKILL.md';
const MAX_SKILL_SCAN_DEPTH = 10;

export interface DiscoverCodexSkillCommandsOptions {
    cwd?: string;
    codexHome?: string;
    homeDir?: string;
}

type SkillCommandResolver = (skillFilePath: string) => string | null;

function expandHomePath(path: string, homeDir: string): string {
    if (path === '~') return homeDir;
    if (path.startsWith(`~${sep}`)) return join(homeDir, path.slice(2));
    return path;
}

async function collectSkillCommands(
    root: string,
    resolveCommand: SkillCommandResolver,
    commands: Set<string>,
): Promise<void> {
    async function walk(dir: string, depth: number): Promise<void> {
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const entryPath = join(dir, entry.name);
            if (entry.isFile() && entry.name === SKILL_FILE) {
                const command = resolveCommand(entryPath);
                if (command) {
                    commands.add(command);
                }
                continue;
            }

            if (entry.isDirectory() && depth < MAX_SKILL_SCAN_DEPTH) {
                await walk(entryPath, depth + 1);
            }
        }
    }

    await walk(root, 0);
}

function parentDirectorySkillName(skillFilePath: string): string | null {
    const skillName = basename(dirname(skillFilePath));
    return skillName.length > 0 ? skillName : null;
}

function pluginSkillName(pluginCacheRoot: string, skillFilePath: string): string | null {
    const parts = relative(pluginCacheRoot, skillFilePath).split(sep);
    const skillsIndex = parts.indexOf('skills');
    const pluginName = parts[1];
    const skillName = skillsIndex >= 0 ? parts[skillsIndex + 1] : undefined;

    if (pluginName && skillName) {
        return `${pluginName}:${skillName}`;
    }

    return parentDirectorySkillName(skillFilePath);
}

export async function discoverCodexSkillCommands(
    opts: DiscoverCodexSkillCommandsOptions = {},
): Promise<string[]> {
    const homeDir = opts.homeDir ?? homedir();
    const cwd = opts.cwd ?? process.cwd();
    const codexHome = expandHomePath(
        opts.codexHome ?? process.env.CODEX_HOME ?? '~/.codex',
        homeDir,
    );
    const commands = new Set<string>();

    await collectSkillCommands(
        join(cwd, '.agents', 'skills'),
        parentDirectorySkillName,
        commands,
    );
    await collectSkillCommands(
        join(codexHome, 'skills'),
        parentDirectorySkillName,
        commands,
    );

    const pluginCacheRoot = join(codexHome, 'plugins', 'cache');
    await collectSkillCommands(
        pluginCacheRoot,
        (skillFilePath) => pluginSkillName(pluginCacheRoot, skillFilePath),
        commands,
    );

    return [...commands].sort((a, b) => a.localeCompare(b));
}
