import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

export type CodexResumeContext = {
    threadId: string;
    rolloutPath: string;
    savedCwd: string | null;
    selectedCwd: string;
};

type ResumeDirectoryChoice = 'session' | 'current';

function resolveCodexHomeDir(): string {
    const codexHome = process.env.CODEX_HOME?.trim();
    if (!codexHome) {
        return join(homedir(), '.codex');
    }
    if (codexHome === '~') {
        return homedir();
    }
    if (codexHome.startsWith('~/')) {
        return join(homedir(), codexHome.slice(2));
    }
    return codexHome;
}

async function findRolloutFileRecursive(root: string, threadId: string): Promise<string | null> {
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    } catch {
        return null;
    }

    for (const entry of entries) {
        const fullPath = join(root, entry.name);
        if (entry.isDirectory()) {
            const nested = await findRolloutFileRecursive(fullPath, threadId);
            if (nested) {
                return nested;
            }
            continue;
        }

        if (entry.isFile() && entry.name.endsWith(`-${threadId}.jsonl`)) {
            return fullPath;
        }
    }

    return null;
}

async function findCodexRolloutFile(threadId: string, codexHomeDir: string): Promise<string | null> {
    const sessionsRoot = join(codexHomeDir, 'sessions');
    const archivedRoot = join(codexHomeDir, 'archived_sessions');

    const sessionRollout = await findRolloutFileRecursive(sessionsRoot, threadId);
    if (sessionRollout) {
        return sessionRollout;
    }

    return findRolloutFileRecursive(archivedRoot, threadId);
}

async function readSavedCwdFromRollout(rolloutPath: string): Promise<string | null> {
    const file = await readFile(rolloutPath, 'utf8');
    const [firstLine] = file.split('\n');
    if (!firstLine?.trim()) {
        return null;
    }

    const parsed = JSON.parse(firstLine) as {
        type?: string;
        payload?: {
            cwd?: unknown;
        };
    };

    return parsed.type === 'session_meta' && typeof parsed.payload?.cwd === 'string'
        ? parsed.payload.cwd
        : null;
}

async function promptResumeDirectory(options: {
    savedCwd: string;
    currentCwd: string;
    savedExists: boolean;
}): Promise<ResumeDirectoryChoice> {
    const { savedCwd, currentCwd, savedExists } = options;
    const defaultChoice = savedExists ? '1' : '2';
    const rl = createInterface({ input, output });
    try {
        output.write('Choose working directory to resume this session\n\n');
        output.write('  Session = latest cwd recorded in the resumed session\n');
        output.write('  Current = your current working directory\n\n');
        output.write(`  1. Use session directory (${savedCwd})${savedExists ? '' : ' [missing on this machine]'}\n`);
        output.write(`  2. Use current directory (${currentCwd})\n\n`);
        const answer = (await rl.question(`  Selection [${defaultChoice}]: `)).trim();
        return answer === '1' ? 'session' : 'current';
    } finally {
        rl.close();
    }
}

export async function resolveCodexResumeContext(opts: {
    threadId: string;
    currentCwd: string;
    interactive: boolean;
    codexHomeDir?: string;
    chooseDirectory?: (options: {
        savedCwd: string;
        currentCwd: string;
        savedExists: boolean;
    }) => Promise<ResumeDirectoryChoice>;
}): Promise<CodexResumeContext> {
    const codexHomeDir = opts.codexHomeDir ?? resolveCodexHomeDir();
    const rolloutPath = await findCodexRolloutFile(opts.threadId, codexHomeDir);

    if (!rolloutPath) {
        throw new Error(
            `No saved Codex session found with ID ${opts.threadId}. Run \`codex resume\` without an ID to choose from existing sessions.`,
        );
    }

    const savedCwd = await readSavedCwdFromRollout(rolloutPath);
    if (!savedCwd) {
        return {
            threadId: opts.threadId,
            rolloutPath,
            savedCwd: null,
            selectedCwd: opts.currentCwd,
        };
    }

    const savedExists = existsSync(savedCwd);
    if (savedCwd === opts.currentCwd) {
        return {
            threadId: opts.threadId,
            rolloutPath,
            savedCwd,
            selectedCwd: savedCwd,
        };
    }

    const chooseDirectory = opts.chooseDirectory ?? promptResumeDirectory;
    const selection = opts.interactive
        ? await chooseDirectory({ savedCwd, currentCwd: opts.currentCwd, savedExists })
        : (savedExists ? 'session' : 'current');

    return {
        threadId: opts.threadId,
        rolloutPath,
        savedCwd,
        selectedCwd: selection === 'session' ? savedCwd : opts.currentCwd,
    };
}
