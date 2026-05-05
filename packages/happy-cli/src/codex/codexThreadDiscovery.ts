import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';

type CodexSessionCandidate = {
    id: string;
    cwd: string;
    timestamp: Date;
    path: string;
};

async function listJsonlFiles(dir: string): Promise<string[]> {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return [];
    }

    const nested = await Promise.all(entries.map(async (entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            return listJsonlFiles(path);
        }
        return entry.isFile() && entry.name.endsWith('.jsonl') ? [path] : [];
    }));

    return nested.flat();
}

function codexSessionDateDir(codexHomeDir: string, date: Date): string {
    const isoDate = date.toISOString().slice(0, 10);
    const [year, month, day] = isoDate.split('-');
    return join(codexHomeDir, 'sessions', year, month, day);
}

function launchWindowSessionDirs(codexHomeDir: string, startedAt: Date, finishedAt: Date): string[] {
    return Array.from(new Set([
        codexSessionDateDir(codexHomeDir, startedAt),
        codexSessionDateDir(codexHomeDir, finishedAt),
    ]));
}

async function readCodexSessionMeta(path: string): Promise<CodexSessionCandidate | null> {
    let firstChunk: string;
    let fileHandle;
    try {
        fileHandle = await open(path, 'r');
        const buffer = Buffer.alloc(64 * 1024);
        const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, 0);
        firstChunk = buffer.subarray(0, bytesRead).toString('utf8');
    } catch {
        return null;
    } finally {
        await fileHandle?.close();
    }

    const firstLine = firstChunk.split(/\r?\n/, 1)[0];
    if (!firstLine) {
        return null;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(firstLine);
    } catch {
        return null;
    }

    const record = parsed as {
        type?: unknown;
        payload?: {
            id?: unknown;
            cwd?: unknown;
            timestamp?: unknown;
        };
    };
    if (record.type !== 'session_meta') {
        return null;
    }
    if (
        typeof record.payload?.id !== 'string' ||
        typeof record.payload.cwd !== 'string' ||
        typeof record.payload.timestamp !== 'string'
    ) {
        return null;
    }

    const timestamp = new Date(record.payload.timestamp);
    if (Number.isNaN(timestamp.getTime())) {
        return null;
    }

    return {
        id: record.payload.id,
        cwd: record.payload.cwd,
        timestamp,
        path,
    };
}

export async function discoverCodexThreadId(opts: {
    codexHomeDir: string;
    cwd: string;
    startedAt: Date;
    finishedAt: Date;
}): Promise<string> {
    const files = (await Promise.all(
        launchWindowSessionDirs(opts.codexHomeDir, opts.startedAt, opts.finishedAt)
            .map((dir) => listJsonlFiles(dir)),
    )).flat();
    const candidates: CodexSessionCandidate[] = [];

    for (const file of files) {
        const candidate = await readCodexSessionMeta(file);
        if (
            candidate &&
            candidate.cwd === opts.cwd &&
            candidate.timestamp >= opts.startedAt &&
            candidate.timestamp <= opts.finishedAt
        ) {
            candidates.push(candidate);
        }
    }

    if (candidates.length === 0) {
        throw new Error(`Could not discover Codex thread id for cwd ${opts.cwd} in launch window.`);
    }
    if (candidates.length > 1) {
        throw new Error(`Ambiguous Codex thread discovery for cwd ${opts.cwd}: ${candidates.map((candidate) => candidate.id).join(', ')}`);
    }

    return candidates[0].id;
}
