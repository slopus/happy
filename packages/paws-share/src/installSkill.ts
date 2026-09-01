import { randomUUID } from 'node:crypto';
import { cp, mkdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type InstallSkillTarget = 'codex' | 'claude-code' | 'all';

export type InstallSkillOptions = {
    target: InstallSkillTarget;
    codexHome?: string;
    claudeHome?: string;
    sourceSkillDirectory?: string;
};

export type InstallSkillResult = {
    installed: string[];
};

function packagedSkillDirectory(): string {
    return fileURLToPath(new URL('../skills/share-session', import.meta.url));
}

async function replaceSkill(source: string, target: string): Promise<void> {
    const skillsRoot = dirname(target);
    await mkdir(skillsRoot, { recursive: true });
    const suffix = `${process.pid}-${randomUUID()}`;
    const temporary = join(skillsRoot, `.share-session-${suffix}.tmp`);
    const backup = join(skillsRoot, `.share-session-${suffix}.bak`);
    await cp(source, temporary, { recursive: true, errorOnExist: true });
    let hadExisting = false;
    try {
        await rename(target, backup);
        hadExisting = true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            await rm(temporary, { recursive: true, force: true });
            throw error;
        }
    }
    try {
        await rename(temporary, target);
        if (hadExisting) await rm(backup, { recursive: true, force: true });
    } catch (error) {
        await rm(temporary, { recursive: true, force: true });
        if (hadExisting) await rename(backup, target).catch(() => undefined);
        throw error;
    }
}

export async function installSkill(options: InstallSkillOptions): Promise<InstallSkillResult> {
    const source = options.sourceSkillDirectory ?? packagedSkillDirectory();
    const destinations: string[] = [];
    if (options.target === 'codex' || options.target === 'all') {
        const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
        destinations.push(join(codexHome, 'skills', 'share-session'));
    }
    if (options.target === 'claude-code' || options.target === 'all') {
        const claudeHome = options.claudeHome ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
        destinations.push(join(claudeHome, 'skills', 'share-session'));
    }
    for (const destination of destinations) await replaceSkill(source, destination);
    return { installed: destinations };
}
