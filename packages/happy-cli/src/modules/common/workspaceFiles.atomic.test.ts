import { mkdtemp, writeFile, readFile, readdir, chmod, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const faults = vi.hoisted(() => ({ partialWrite: false, rename: false, externalTarget: '' }));
vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual,
        // Faults affect real file bytes: never fake a successful filesystem operation.
        open: async (...args: Parameters<typeof actual.open>) => {
            const handle = await actual.open(...args);
            if (args[1] !== 'wx') return handle;
            return new Proxy(handle, { get(target, property) {
                if (property === 'writeFile') return async (bytes: Buffer) => {
                    if (faults.partialWrite) { await target.writeFile(bytes.subarray(0, 4)); throw new Error('Injected ENOSPC'); }
                    await target.writeFile(bytes);
                    if (faults.externalTarget) await actual.writeFile(faults.externalTarget, '# External update');
                };
                const value = Reflect.get(target, property, target);
                return typeof value === 'function' ? value.bind(target) : value;
            } });
        },
        // Covers the old in-place implementation as well as tempfile writeFile variants.
        writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
            if (faults.partialWrite) { await actual.writeFile(args[0], Buffer.from(args[1] as Uint8Array).subarray(0, 4)); throw new Error('Injected ENOSPC'); }
            return actual.writeFile(...args);
        },
        rename: async (...args: Parameters<typeof actual.rename>) => {
            if (faults.rename) throw new Error('Injected rename failure');
            return actual.rename(...args);
        },
    };
});
import { createWorkspaceFileHandlers } from './workspaceFiles';
const directories: string[] = [];
beforeEach(() => { faults.partialWrite = false; faults.rename = false; faults.externalTarget = ''; });
afterEach(async () => { faults.partialWrite = false; await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'paws-atomic-save-')); directories.push(root);
    const file = join(root, '方案.md'); await writeFile(file, '# Original document'); await chmod(file, 0o640);
    return { root, file, handlers: createWorkspaceFileHandlers(root), input: { path: '方案.md', content: Buffer.from('# Saved document').toString('base64'), expectedHash: createHash('sha256').update('# Original document').digest('hex') } };
}
describe('workspace save preserves original bytes on failure', () => {
    it('retains the original after a partial write failure and removes its temporary file', async () => {
        const t = await fixture(); faults.partialWrite = true;
        const result = await t.handlers.write(t.input);
        expect(result.success).toBe(false);
        expect(await readFile(t.file, 'utf8')).toBe('# Original document');
        expect(await readdir(t.root)).toEqual(['方案.md']);
    });
    it('retains the original when atomic replacement fails', async () => {
        const t = await fixture(); faults.rename = true;
        const result = await t.handlers.write(t.input);
        expect(result.success).toBe(false);
        expect(await readFile(t.file, 'utf8')).toBe('# Original document');
        expect(await readdir(t.root)).toEqual(['方案.md']);
    });
    it('rechecks the baseline after preparing bytes so an external update is not replaced', async () => {
        const t = await fixture(); faults.externalTarget = t.file;
        expect(await t.handlers.write(t.input)).toMatchObject({ success: false, error: expect.stringContaining('hash') });
        expect(await readFile(t.file, 'utf8')).toBe('# External update');
        expect(await readdir(t.root)).toEqual(['方案.md']);
    });
    it('saves complete bytes and retains existing file permissions', async () => {
        const t = await fixture();
        expect(await t.handlers.write(t.input)).toMatchObject({ success: true });
        expect(await readFile(t.file, 'utf8')).toBe('# Saved document');
        expect((await stat(t.file)).mode & 0o777).toBe(0o640);
        expect(await readdir(t.root)).toEqual(['方案.md']);
    });
});
