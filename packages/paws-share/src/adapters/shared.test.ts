import { afterEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveStructuredAttachment } from './shared';
import { createTemporaryDirectory, removeTemporaryDirectory } from '../testSupport/temporaryDirectory';

describe('resolveStructuredAttachment', () => {
    const directories: string[] = [];

    afterEach(async () => {
        await Promise.all(directories.splice(0).map(removeTemporaryDirectory));
    });

    it('keeps attachment IDs stable within a session and isolated across sessions', async () => {
        const directory = await createTemporaryDirectory('paws-share-attachment-id-');
        directories.push(directory);
        await writeFile(join(directory, 'shared.png'), Buffer.from('same attachment'));

        const sessionA = { provider: 'codex' as const, path: join(directory, 'session-a.jsonl'), cwd: directory };
        const sessionB = { provider: 'codex' as const, path: join(directory, 'session-b.jsonl'), cwd: directory };
        const first = await resolveStructuredAttachment(sessionA, 'shared.png', directory);
        const repeated = await resolveStructuredAttachment(sessionA, 'shared.png', directory);
        const secondSession = await resolveStructuredAttachment(sessionB, 'shared.png', directory);

        expect(repeated.attachmentId).toBe(first.attachmentId);
        expect(secondSession.attachmentId).not.toBe(first.attachmentId);
    });
});
