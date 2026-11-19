import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { configuration } from '@/configuration';
import type { ConversationItem } from './history';
const directory = () => join(configuration.happyHomeDir, 'cross-agent-context');
const pathFor = (id: string) => {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid imported thread ID');
    return join(directory(), `${id}.json`);
};
export type ImportPrefix = { directory: string; history: ConversationItem[]; turnIds?: string[] };
export async function readImportPrefix(id: string, required = false): Promise<ImportPrefix | undefined> {
    if (!/^[a-f0-9-]{36}$/i.test(id)) {
        if (required) throw new Error('Invalid imported thread ID');
        return undefined;
    }
    try { return JSON.parse(await readFile(pathFor(id), 'utf8')); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (required) throw new Error('Imported source context is unavailable on this machine');
        return undefined;
    }
}
export async function writeImportPrefix(id: string, prefix: ImportPrefix): Promise<void> {
    await mkdir(directory(), { recursive: true, mode: 0o700 });
    const path = pathFor(id); const temp = `${path}.tmp`;
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(prefix)); await file.sync(); }
    finally { await file.close(); }
    await rename(temp, path);
}
export async function copyImportPrefix(sourceId: string, targetId: string, targetDirectory?: string): Promise<void> {
    // Native fork preserves injected model context but not its projected turns.
    // Keep the portable counterpart in sync with the native child identity.
    const prefix = await readImportPrefix(sourceId);
    if (prefix) await writeImportPrefix(targetId, { ...prefix, directory: targetDirectory ?? prefix.directory });
}

/** A portable import is one closed native turn. Do not pretend to rewind inside it. */
export async function assertImportRewindBoundary(threadId: string, turnId: string): Promise<void> {
    const prefix = await readImportPrefix(threadId);
    if (prefix?.turnIds?.includes(turnId)) throw new Error('Imported history can only be forked as a whole. Choose a message after the import to rewind.');
}
