import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { TranscriptCandidate } from './types';

export class AmbiguousTranscriptError extends Error {
    constructor(readonly candidates: TranscriptCandidate[]) {
        super(`More than one session matches the current directory: ${candidates.map((candidate) => candidate.path).join(', ')}`);
    }
}

export function selectCurrentCandidate(candidates: TranscriptCandidate[], cwd: string): TranscriptCandidate {
    const normalizedCwd = resolve(cwd);
    const matching = candidates.filter((candidate) => candidate.cwd && resolve(candidate.cwd) === normalizedCwd);
    if (matching.length === 0) throw new Error('No session found for the current directory');
    if (matching.length > 1) throw new AmbiguousTranscriptError(matching.sort((left, right) => (right.modifiedAt ?? 0) - (left.modifiedAt ?? 0)));
    return matching[0];
}

async function jsonlFiles(root: string): Promise<string[]> {
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
    const files: string[] = [];
    for (const entry of entries) {
        const child = join(root, entry.name);
        if (entry.isDirectory()) files.push(...await jsonlFiles(child));
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(child);
    }
    return files;
}

async function candidateFromFile(path: string, provider: TranscriptCandidate['provider']): Promise<TranscriptCandidate | null> {
    const raw = await readFile(path, 'utf8');
    let cwd: string | undefined;
    for (const line of raw.split(/\r?\n/).slice(0, 100)) {
        if (!line) continue;
        try {
            const value = JSON.parse(line) as any;
            cwd = provider === 'codex' && value.type === 'session_meta' ? value.payload?.cwd : value.cwd;
            if (typeof cwd === 'string') break;
        } catch {
            return null;
        }
    }
    if (!cwd) return null;
    const metadata = await stat(path);
    return {
        provider,
        path,
        cwd: resolve(dirname(path), cwd),
        modifiedAt: metadata.mtimeMs,
    };
}

export async function discoverCurrentTranscript(options: {
    cwd?: string;
    codexHome?: string;
    claudeHome?: string;
} = {}): Promise<TranscriptCandidate> {
    const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
    const claudeHome = options.claudeHome ?? join(homedir(), '.claude');
    const codexFiles = await jsonlFiles(join(codexHome, 'sessions'));
    const claudeFiles = await jsonlFiles(join(claudeHome, 'projects'));
    const candidates = (await Promise.all([
        ...codexFiles.map((path) => candidateFromFile(path, 'codex')),
        ...claudeFiles.map((path) => candidateFromFile(path, 'claude-code')),
    ])).filter((candidate): candidate is TranscriptCandidate => Boolean(candidate));
    return selectCurrentCandidate(candidates, options.cwd ?? process.cwd());
}
