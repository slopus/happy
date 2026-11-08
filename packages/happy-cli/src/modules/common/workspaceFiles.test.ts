import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkspaceFileHandlers } from './workspaceFiles';
const fixtures: string[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function setup() {
    const base = await mkdtemp(join(tmpdir(), 'paws-workspace-')); fixtures.push(base);
    const root = join(base, 'project'); await mkdir(root);
    await writeFile(join(root, '方案.md'), '# 你好'); await writeFile(join(base, 'private'), 'PRIVATE');
    await symlink(join(base, 'private'), join(root, 'escape'));
    return { root, base, handlers: createWorkspaceFileHandlers(root) };
}
describe('workspace-only file RPC', () => {
    it('lists real Unicode names and returns read bytes and their baseline hash', async () => {
        const { root, handlers } = await setup();
        expect(await handlers.list({ path: root })).toMatchObject({ success: true, entries: expect.arrayContaining([{ name: '方案.md', type: 'file' }]) });
        const result = await handlers.read({ path: '方案.md' });
        expect(result).toMatchObject({ success: true, content: Buffer.from('# 你好').toString('base64'), hash: createHash('sha256').update('# 你好').digest('hex') });
    });
    it('rejects parent traversal and an in-root symlink to outside before reading or writing', async () => {
        const { handlers, base } = await setup();
        for (const path of ['../private', 'escape', join(base, 'private')]) {
            expect(await handlers.read({ path })).toMatchObject({ success: false });
            expect(await handlers.write({ path, content: Buffer.from('bad').toString('base64'), expectedHash: createHash('sha256').update('PRIVATE').digest('hex') })).toMatchObject({ success: false });
        }
        expect(await readFile(join(base, 'private'), 'utf8')).toBe('PRIVATE');
    });
    it('persists a hashed edit but rejects a stale baseline and missing hash', async () => {
        const { root, handlers } = await setup();
        const first = await handlers.read({ path: '方案.md' });
        if (!first.success) throw new Error(first.error);
        expect(await handlers.write({ path: '方案.md', content: Buffer.from('# Saved').toString('base64'), expectedHash: first.hash })).toMatchObject({ success: true });
        expect(await readFile(join(root, '方案.md'), 'utf8')).toBe('# Saved');
        expect(await handlers.write({ path: '方案.md', content: '', expectedHash: first.hash })).toMatchObject({ success: false, error: expect.stringContaining('hash') });
        expect(await handlers.write({ path: '方案.md', content: '' })).toMatchObject({ success: false });
    });
});
