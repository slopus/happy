import { chmod, cp, lstat, mkdir, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join, resolve } from 'node:path';
import * as tmp from 'tmp';

const INHERITED_CODEX_HOME_ENTRIES = new Set([
    'AGENTS.md',
    'config.toml',
    'hooks.json',
    'skills',
    'plugins',
    'prompts',
    'rules',
    'instructions',
    'memories',
]);

function expandHome(pathValue: string, homeDir: string): string {
    return pathValue.replace(/^~(?=$|[\\/])/, homeDir);
}

export function resolveCodexHome(opts: {
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
} = {}): string {
    const env = opts.env ?? process.env;
    const homeDir = opts.homeDir ?? os.homedir();
    const configuredHome = env.CODEX_HOME?.trim();
    return resolve(configuredHome ? expandHome(configuredHome, homeDir) : join(homeDir, '.codex'));
}

function shouldInheritCodexHomeEntry(name: string): boolean {
    return INHERITED_CODEX_HOME_ENTRIES.has(name) || name.endsWith('.config.toml');
}

async function sourceExists(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    } catch {
        return false;
    }
}

async function inheritCodexHomeEntry(sourcePath: string, destinationPath: string): Promise<void> {
    const linkStats = await lstat(sourcePath);
    const targetStats = linkStats.isSymbolicLink()
        ? await stat(sourcePath).catch(() => linkStats)
        : linkStats;
    const linkType = targetStats.isDirectory()
        ? (process.platform === 'win32' ? 'junction' : 'dir')
        : 'file';

    try {
        await symlink(sourcePath, destinationPath, linkType);
    } catch {
        await cp(sourcePath, destinationPath, {
            recursive: true,
            dereference: false,
            force: false,
            errorOnExist: false,
        });
    }
}

export async function prepareCodexHomeWithAuth(authJson: string, opts: {
    sourceHome?: string;
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    createTempDir?: () => string;
    /** Application bindings supply their own policy; do not inherit host MCP/config. */
    inheritConfiguration?: boolean;
} = {}): Promise<string> {
    const sourceHome = opts.sourceHome ?? resolveCodexHome({ env: opts.env, homeDir: opts.homeDir });
    const tempHome = opts.createTempDir?.() ?? tmp.dirSync({ prefix: 'happy-codex-home-' }).name;
    if (resolve(tempHome) === resolve(sourceHome)) throw new Error('Codex home must be isolated');
    try {
        await mkdir(tempHome, { recursive: true, mode: 0o700 });
        await chmod(tempHome, 0o700);

        if (opts.inheritConfiguration !== false && await sourceExists(sourceHome)) {
            const entries = await readdir(sourceHome, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.name === 'auth.json' || !shouldInheritCodexHomeEntry(entry.name)) {
                    continue;
                }
                await inheritCodexHomeEntry(join(sourceHome, entry.name), join(tempHome, entry.name));
            }
        }

        await writeFile(join(tempHome, 'auth.json'), authJson, { mode: 0o600, flag: 'wx' });
        return tempHome;
    } catch {
        await rm(tempHome, { recursive: true, force: true });
        throw new Error('Unable to prepare private Codex home');
    }
}
