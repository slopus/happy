/** Verify the encrypted file RPCs against a real session directory outside HOME. */
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerCommonHandlers } from './registerCommonHandlers';

describe('session file RPCs outside HOME', () => {
    let fixture: string;
    let project: string;
    let manager: RpcHandlerManager;
    const key = randomBytes(32);

    beforeEach(async () => {
        fixture = await mkdtemp(join(tmpdir(), 'paws-session-files-'));
        project = join(fixture, 'External SSD', 'demo');
        await mkdir(join(project, 'src'), { recursive: true });
        await writeFile(join(project, 'src', 'hello.txt'), 'hello external session');
        manager = new RpcHandlerManager({
            scopePrefix: 'file-test', encryptionKey: key, encryptionVariant: 'dataKey', logger: () => {},
        });
        registerCommonHandlers(manager, project);
    });

    afterEach(async () => {
        await rm(fixture, { recursive: true, force: true });
    });

    async function call(method: string, params: { path: string; maxDepth?: number; content?: string }) {
        const response = await manager.handleRequest({
            method: `file-test:${method}`,
            params: encodeBase64(encrypt(key, 'dataKey', params)),
        });
        return decrypt(key, 'dataKey', decodeBase64(response));
    }

    it('lists the session root, reads a nested file, and builds its tree', async () => {
        expect(await call('listDirectory', { path: project })).toMatchObject({
            success: true, entries: [{ name: 'src', type: 'directory' }],
        });
        expect(await call('readFile', { path: 'src/hello.txt' })).toEqual({
            success: true, content: Buffer.from('hello external session').toString('base64'),
        });
        expect(await call('getDirectoryTree', { path: project, maxDepth: 2 })).toMatchObject({
            success: true, tree: { children: [{ name: 'src', children: [{ name: 'hello.txt', type: 'file' }] }] },
        });
    });

    it('rejects reads and writes above the session directory', async () => {
        for (const method of ['listDirectory', 'readFile', 'getDirectoryTree', 'writeFile']) {
            expect(await call(method, { path: '..', maxDepth: 1, content: '' })).toMatchObject({
                success: false, error: expect.stringContaining('Access denied'),
            });
        }
    });
});
