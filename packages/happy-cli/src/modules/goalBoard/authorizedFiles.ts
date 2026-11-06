import { constants, createWriteStream } from 'node:fs';
import { chmod, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { safePath } from './catalog';

/** The open FD, resolved name and authorized inode must agree before any source read. */
export async function openAuthorizedFile(root: string, candidate: string, maxBytes: number) {
    const actual = await safePath(root, candidate);
    const handle = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error('Not a regular file');
        if (info.size > maxBytes) throw new Error(`File too large (maximum ${maxBytes} bytes)`);
        if (await safePath(root, candidate) !== actual) throw new Error('Source path changed');
        const named = await stat(actual);
        if (named.dev !== info.dev || named.ino !== info.ino || await safePath(root, candidate) !== actual) throw new Error('Source identity changed');
        return { handle, info, actual };
    } catch (error) { await handle.close(); throw error; }
}

/** Existing upload APIs may reopen paths after network awaits. Give them a private immutable copy,
 * streamed from the already-authorized FD, instead of a mutable source pathname. */
export async function withStagedAttachment<T>(root: string, candidate: string, maxBytes: number, assertCurrent: () => void, upload: (stagedPath: string) => Promise<T>): Promise<T> {
    const source = await openAuthorizedFile(root, candidate, maxBytes);
    let directory: string | undefined;
    try {
        assertCurrent();
        directory = await mkdtemp(join(tmpdir(), 'paws-goal-preview-'));
        await chmod(directory, 0o700);
        const stagedPath = join(directory, basename(candidate));
        const writer = createWriteStream(stagedPath, { flags: 'wx', mode: 0o600 });
        if (source.info.size === 0) { writer.end(); await new Promise<void>((resolve, reject) => { writer.on('close', resolve); writer.on('error', reject); }); }
        else await pipeline(source.handle.createReadStream({ autoClose: false, start: 0, end: source.info.size - 1 }), writer);
        const copied = await stat(stagedPath);
        if (copied.size !== source.info.size || copied.size > maxBytes) throw new Error('Source size changed during staging');
        await chmod(stagedPath, 0o400);
        assertCurrent();
        return await upload(stagedPath);
    } finally {
        await source.handle.close();
        if (directory) await rm(directory, { recursive: true, force: true });
    }
}
