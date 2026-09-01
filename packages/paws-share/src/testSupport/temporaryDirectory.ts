import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export async function createTemporaryDirectory(prefix: string): Promise<string> {
    return mkdtemp(join(tmpdir(), prefix));
}

export async function removeTemporaryDirectory(directory: string): Promise<void> {
    await rm(directory, { recursive: true, force: true });
}
