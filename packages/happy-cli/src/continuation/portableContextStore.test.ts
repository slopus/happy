/** Real filesystem and HTTP coverage for private portable history. */
import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { PortableContextArchive, PortableContextDescriptor, PortableContextBoundary } from '@slopus/happy-wire';
import { PortableContextStore } from './portableContextStore';
import { encryptBlob } from '@/api/encryption';

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const decode = (result: CallToolResult): Record<string, any> => JSON.parse((result.content[0] as { text: string }).text);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function archive(text = 'private history marker'): PortableContextArchive {
    return { snapshot: { version: 1, id: randomUUID(), rootSessionId: 'source', sourceSessionId: 'source',
        heads: [{ sessionId: 'source', afterSeq: 0, throughSeq: 2 }],
        items: [{ id: 'item', sourceSessionId: 'source', seq: 1, role: 'user', text }] },
        blobKeys: { source: Buffer.alloc(32, 7).toString('base64') } };
}

async function fixture(serverUrl = 'http://localhost:1') {
    const directory = await fs.mkdtemp(join(tmpdir(), 'portable-history-test-'));
    cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
    let descriptor: unknown;
    let boundary: PortableContextBoundary | undefined;
    let allowed = true;
    const options = { directory, sessionId: 'target', serverUrl, token: 'private-token', encryptionKey: new Uint8Array(32).fill(5),
        descriptor: () => descriptor, boundary: () => boundary, allowed: () => allowed };
    const store = new PortableContextStore(options);
    cleanups.push(() => store.dispose());
    return { store, directory, options, activate: (value: unknown) => { descriptor = value; },
        setBoundary: (value: PortableContextBoundary) => { boundary = value; }, setAllowed: (value: boolean) => { allowed = value; } };
}

async function upload(store: PortableContextStore, value: PortableContextArchive, chunks?: string[]): Promise<PortableContextDescriptor> {
    const raw = JSON.stringify(value);
    const parts = chunks ?? Array.from({ length: Math.ceil(raw.length / 47000) }, (_, i) => raw.slice(i * 47000, (i + 1) * 47000));
    for (let index = parts.length - 1; index >= 0; index--) await store.upload({ action: 'append', snapshotId: value.snapshot.id, index, chunk: parts[index] });
    return (await store.upload({ action: 'commit', snapshotId: value.snapshot.id, chunks: parts.length, sha256: digest(raw) })).descriptor!;
}

async function files(directory: string): Promise<string[]> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]))).flat();
}

describe('PortableContextStore', () => {
    it('restores the authorized active snapshot after old-client field omission and restart, while clear remains durable', async () => {
        const f = await fixture(); const value = archive();
        const descriptor = await upload(f.store, value); f.activate(descriptor);
        f.activate(undefined);
        expect(decode(await f.store.read({ itemId: 'item' })).text).toBe(value.snapshot.items[0].text);
        f.activate(null); await expect(f.store.read({})).rejects.toThrow('descriptor mismatch'); f.activate(undefined);
        await f.store.dispose();
        const restarted = new PortableContextStore(f.options); cleanups.push(() => restarted.dispose());
        expect(decode(await restarted.read({ itemId: 'item' })).text).toBe(value.snapshot.items[0].text);
        const boundary = { id: randomUUID(), afterSeq: 10 };
        await restarted.revoke(boundary); f.setBoundary(boundary);
        await restarted.dispose();
        const cleared = new PortableContextStore(f.options); cleanups.push(() => cleared.dispose());
        await expect(cleared.read({})).rejects.toThrow('cleared');
        await expect(upload(cleared, value)).rejects.toThrow('cleared boundary');
        const next = archive('new history'); f.activate(await upload(cleared, next));
        expect(decode(await cleared.read({ itemId: 'item' })).text).toBe('new history');
    });

    it('fences warm-cache reads during clear and lifecycle revocation', async () => {
        const f = await fixture(); f.activate(await upload(f.store, archive()));
        await f.store.read({});
        const pending = f.store.read({}); const revoked = f.store.revoke();
        await expect(pending).rejects.toThrow(); await revoked;
        const g = await fixture(); g.activate(await upload(g.store, archive()));
        await g.store.read({});
        const archivePending = g.store.read({});
        const archiveRejected = expect(archivePending).rejects.toThrow('archived');
        g.setAllowed(false); await g.store.invalidateForLifecycle();
        await archiveRejected;
        await expect(g.store.attachment({ attachmentId: 'anything' })).rejects.toThrow('archived');
        await expect(upload(g.store, archive())).rejects.toThrow('archived');
    });

    it('rejects an explicit boundary conflict even when the epoch UUID is unchanged', async () => {
        const f = await fixture(); const boundary = { id: randomUUID(), afterSeq: 10 };
        f.setBoundary(boundary); f.activate(await upload(f.store, archive()));
        f.setBoundary({ ...boundary, afterSeq: 11 });
        await expect(f.store.read({})).rejects.toThrow('cleared');
        await expect(upload(f.store, archive())).rejects.toThrow('boundary was cleared');
    });
    it('keeps a logical root outside history heads after an explicit clear', async () => {
        const f = await fixture(); const value = archive();
        value.snapshot.rootSessionId = 'older-logical-root';
        f.activate(await upload(f.store, value));
        expect(decode(await f.store.read({})).items[0].id).toBe('item');
    });
    it('encrypts every durable byte, preserves split Unicode and pages all text after restart', async () => {
        const f = await fixture();
        const text = `private history marker ${'long complete history '.repeat(5000)}😀tail`;
        const value = archive(text);
        const raw = JSON.stringify(value);
        const split = raw.indexOf('😀') + 1;
        const parts: string[] = [];
        for (let start = 0; start < split; start += 47000) parts.push(raw.slice(start, Math.min(start + 47000, split)));
        parts.push(raw.slice(split));
        const descriptor = await upload(f.store, value, parts);
        f.activate(descriptor);
        for (const path of await files(f.directory)) {
            const bytes = await fs.readFile(path);
            expect(bytes.includes(Buffer.from('private history marker'))).toBe(false);
            expect(bytes.includes(Buffer.from(value.blobKeys.source))).toBe(false);
            expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
        }
        const restarted = new PortableContextStore(f.options);
        cleanups.push(() => restarted.dispose());
        expect(await upload(restarted, value, parts)).toEqual(descriptor);
        const list = decode(await restarted.read({ query: 'complete history' }));
        expect(list.items[0].textLength).toBe(text.length);
        let restored = '';
        let offset: number | null = 0;
        while (offset !== null) {
            const page = decode(await restarted.read({ itemId: 'item', textOffset: offset, limit: 16000 }));
            expect(page.text.length).toBeLessThanOrEqual(16000);
            restored += page.text;
            offset = page.nextTextOffset;
        }
        expect(restored).toBe(text);
    });

    it('rejects incomplete, mismatched, changed or extra chunks without publishing history', async () => {
        const f = await fixture();
        const value = archive(); const raw = JSON.stringify(value);
        const append = { action: 'append', snapshotId: value.snapshot.id, index: 0, chunk: raw };
        await f.store.upload(append);
        await f.store.upload(append);
        await expect(f.store.upload({ ...append, chunk: 'changed' })).rejects.toThrow('immutable');
        await expect(f.store.upload({ action: 'commit', snapshotId: value.snapshot.id, chunks: 2, sha256: digest(raw) })).rejects.toThrow('chunk count');
        await expect(f.store.upload({ action: 'commit', snapshotId: value.snapshot.id, chunks: 1, sha256: '0'.repeat(64) })).rejects.toThrow('digest');
        const descriptor = await upload(f.store, value);
        await expect(f.store.upload({ ...append, index: 1 })).rejects.toThrow('immutable');
        f.activate({ ...descriptor, sourceSessionId: 'wrong' });
        await expect(f.store.read({})).rejects.toThrow('descriptor');
        f.activate(descriptor); await f.store.revoke();
        await expect(f.store.read({})).rejects.toThrow('cleared');
        f.activate(undefined);
        await expect(f.store.read({})).rejects.toThrow('No committed');
    });

    it.each(['head', 'seq', 'ref', 'key', 'duplicate'])('rejects invalid %s without including private input in errors', async kind => {
        const f = await fixture(); const value = archive('SECRET-MARKER');
        if (kind === 'head') value.snapshot.heads[0].afterSeq = 3;
        if (kind === 'seq') value.snapshot.items[0].seq = 5;
        if (kind === 'key') value.blobKeys.source = 'SECRET-KEY';
        if (kind === 'duplicate') value.snapshot.items.push({ ...value.snapshot.items[0] });
        if (kind === 'ref') value.snapshot.items[0].attachments = [{ id: 'file', sourceSessionId: 'source', name: 'x',
            ref: 'sessions/source/attachments/../secret', kind: 'file', size: 1, encrypted: true }];
        let error: unknown; try { await upload(f.store, value); } catch (caught) { error = caught; }
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).not.toContain('SECRET');
        await expect(f.store.read({})).rejects.toThrow('No committed');
    });

    it('downloads source-scoped encrypted image/PDF and streams plaintext media originals with private permissions', async () => {
        const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
        const pdf = Buffer.from('%PDF-1.7 original private document');
        const media = Buffer.from('original video bytes');
        const blobs = new Map([['image', encryptBlob(image, new Uint8Array(32).fill(7))],
            ['pdf', encryptBlob(pdf, new Uint8Array(32).fill(7))], ['video', media]]);
        const requested: Array<{ path: string; ref?: string; auth?: string }> = [];
        let serverUrl = '';
        const server = createServer(async (req, res) => {
            if (req.method === 'POST') {
                let body = ''; for await (const chunk of req) body += chunk;
                const ref = JSON.parse(body).ref;
                requested.push({ path: req.url!, ref, auth: req.headers.authorization });
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify({ downloadUrl: `${serverUrl}/blob/${ref.split('/').at(-1).split('.')[0]}` }));
            } else { res.end(blobs.get(req.url!.split('/').at(-1)!)!); }
        });
        serverUrl = await listen(server);
        const f = await fixture(serverUrl); const value = archive();
        value.snapshot.items[0].attachments = [
            { id: 'image', sourceSessionId: 'source', ref: 'sessions/source/attachments/image.enc', name: '../image.png', kind: 'image', size: image.length, encrypted: true },
            { id: 'pdf', sourceSessionId: 'source', ref: 'sessions/source/attachments/pdf.enc', name: 'paper.pdf', kind: 'file', size: pdf.length, encrypted: true },
            { id: 'video', sourceSessionId: 'source', ref: 'sessions/source/attachments/video.mp4', name: 'film.mp4', kind: 'video', size: media.length, encrypted: false },
        ];
        f.activate(await upload(f.store, value));
        const paths: string[] = [];
        for (const [id, bytes] of [['image', image], ['pdf', pdf], ['video', media]] as const) {
            const result = await f.store.attachment({ attachmentId: id }); const item = decode(result);
            paths.push(item.path);
            expect(await fs.readFile(item.path)).toEqual(bytes);
            expect((await fs.stat(item.path)).mode & 0o777).toBe(0o600);
            expect((await fs.stat(dirname(item.path))).mode & 0o777).toBe(0o700);
            expect(result.content.some(block => block.type === 'image')).toBe(id === 'image');
            expect(JSON.stringify(result)).not.toContain(value.blobKeys.source);
        }
        expect(requested.map(request => request.ref)).toEqual(value.snapshot.items[0].attachments.map(item => item.ref));
        expect(requested.every(request => request.path.includes('/sessions/source/') && request.auth === 'Bearer private-token')).toBe(true);
        await expect(f.store.attachment({ attachmentId: 'https://evil' })).rejects.toThrow('manifest');
        await f.store.dispose();
        for (const path of paths) await expect(fs.stat(path)).rejects.toThrow();
    });

    it('does not expose a file after the active descriptor is revoked during download', async () => {
        let begin!: () => void; const started = new Promise<void>(resolve => { begin = resolve; });
        let finish!: () => void; const completed = new Promise<void>(resolve => { finish = resolve; });
        let serverUrl = '';
        const server = createServer(async (req, res) => {
            if (req.method === 'POST') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ downloadUrl: `${serverUrl}/blob` })); }
            else { res.write('a'); begin(); await completed; res.end('b'); }
        });
        serverUrl = await listen(server);
        const f = await fixture(serverUrl); const value = archive();
        value.snapshot.items[0].attachments = [{ id: 'video', sourceSessionId: 'source', ref: 'sessions/source/attachments/video.mp4', name: 'v.mp4', kind: 'video', size: 2, encrypted: false }];
        f.activate(await upload(f.store, value));
        const pending = expect(f.store.attachment({ attachmentId: 'video' })).rejects.toThrow('could not be materialized');
        await started; await f.store.revoke(); finish();
        await pending;
    });

    it('rejects unsigned foreign origins, omits owner tokens on signed downloads and bounds chunked bytes', async () => {
        const foreignRequests: Array<string | undefined> = [];
        const foreign = createServer((req, res) => { foreignRequests.push(req.headers.authorization); res.end('ab'); });
        const foreignUrl = await listen(foreign);
        let mode: 'unsigned' | 'signed' | 'oversized' = 'unsigned';
        let serverUrl = '';
        const server = createServer((req, res) => {
            if (req.method === 'POST') {
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify({ downloadUrl: mode === 'oversized' ? `${serverUrl}/blob`
                    : `${foreignUrl}/blob${mode === 'signed' ? '?X-Amz-Signature=fixture' : ''}` }));
            } else { res.write('a'); res.end('bc'); }
        });
        serverUrl = await listen(server);
        const f = await fixture(serverUrl); const value = archive();
        value.snapshot.items[0].attachments = [{ id: 'video', sourceSessionId: 'source', ref: 'sessions/source/attachments/video.mp4', name: 'v.mp4', kind: 'video', size: 2, encrypted: false }];
        f.activate(await upload(f.store, value));
        await expect(f.store.attachment({ attachmentId: 'video' })).rejects.toThrow('could not be materialized');
        expect(foreignRequests).toEqual([]);
        mode = 'signed';
        const result = decode(await f.store.attachment({ attachmentId: 'video' }));
        expect(await fs.readFile(result.path, 'utf8')).toBe('ab');
        expect(foreignRequests).toEqual([undefined]);
        mode = 'oversized';
        await expect(f.store.attachment({ attachmentId: 'video' })).rejects.toThrow('could not be materialized');
    });
});

async function listen(server: Server): Promise<string> {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
