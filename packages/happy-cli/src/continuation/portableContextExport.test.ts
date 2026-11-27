/** Private RPC export preserves exact committed bytes and durable clear authority. */
import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { PortableContextArchive, PortableContextBoundary, PortableContextDescriptor } from '@slopus/happy-wire';
import { PortableContextStore, type PortableContextStoreOptions } from './portableContextStore';

const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function archive(text: string): PortableContextArchive {
    return { snapshot: { version: 1, id: randomUUID(), rootSessionId: 'parent', sourceSessionId: 'parent',
        heads: [{ sessionId: 'parent', throughSeq: 10, afterSeq: 0 }],
        items: [{ id: 'original', sourceSessionId: 'parent', seq: 10, role: 'tool', text }] },
        blobKeys: { parent: Buffer.alloc(32, 17).toString('base64') } };
}

async function fixture() {
    const directory = await fs.mkdtemp(join(tmpdir(), 'portable-export-test-'));
    cleanups.push(() => fs.rm(directory, { force: true, recursive: true }));
    let descriptor: unknown;
    let boundary: PortableContextBoundary | undefined;
    let allowed = true;
    const options: PortableContextStoreOptions = { directory, sessionId: 'branch', serverUrl: 'https://relay.test', token: 'test-only',
        encryptionKey: new Uint8Array(32).fill(23), descriptor: () => descriptor, boundary: () => boundary, allowed: () => allowed };
    const store = new PortableContextStore(options);
    cleanups.push(() => store.dispose());
    return { store, options, hint: (value: unknown) => { descriptor = value; },
        boundary: (value: PortableContextBoundary) => { boundary = value; }, allowed: (value: boolean) => { allowed = value; } };
}

async function uploadRaw(store: PortableContextStore, raw: string, id: string): Promise<PortableContextDescriptor> {
    const chunks = Math.ceil(raw.length / 48000);
    for (let index = chunks - 1; index >= 0; index--) {
        await store.upload({ action: 'append', snapshotId: id, index, chunk: raw.slice(index * 48000, (index + 1) * 48000) });
    }
    return (await store.upload({ action: 'commit', snapshotId: id, chunks, sha256: digest(raw) })).descriptor!;
}

describe('private immutable archive export', () => {
    it('returns exact original JSON spelling/order/whitespace and blob keys across Unicode-split pages', async () => {
        const f = await fixture(); const value = archive('SPLIT');
        const serialize = () => JSON.stringify({ blobKeys: value.blobKeys, snapshot: {
            items: value.snapshot.items, heads: value.snapshot.heads, sourceSessionId: 'parent',
            rootSessionId: 'parent', id: value.snapshot.id, version: 1,
        } }, null, 2) + '\n';
        const prefixLength = serialize().indexOf('SPLIT');
        value.snapshot.items[0].text = 'x'.repeat(48000 - prefixLength - 1) + '😀' + 'z'.repeat(100000);
        const raw = serialize();
        const descriptor = await uploadRaw(f.store, raw, value.snapshot.id); f.hint(descriptor);
        let offset = 0; let exported = ''; let pages = 0;
        for (;;) {
            const page = await f.store.exportPage({ textOffset: offset });
            expect(page.descriptor).toEqual(descriptor);
            expect(page.chunk.length).toBeLessThanOrEqual(48000);
            if (pages === 0) expect(page.chunk.charCodeAt(page.chunk.length - 1)).toBe(0xd83d);
            exported += page.chunk; pages++;
            if (page.nextTextOffset === null) break;
            expect(page.nextTextOffset).toBe(offset + page.chunk.length);
            offset = page.nextTextOffset;
            f.hint(undefined); // An old schema clock omits the public hint.
        }
        expect(pages).toBeGreaterThan(2);
        expect(exported === raw).toBe(true);
        expect(digest(exported)).toBe(descriptor.sha256);
        expect(digest(JSON.stringify(JSON.parse(exported)))).not.toBe(descriptor.sha256);
        expect(JSON.parse(exported).blobKeys).toEqual(value.blobKeys);
    });

    it('reopens an archived-source reader after disposal and recovers same-epoch old-clock omissions', async () => {
        const f = await fixture(); const value = archive('frozen inherited evidence');
        const raw = JSON.stringify(value);
        await uploadRaw(f.store, raw, value.snapshot.id); f.hint(undefined);
        await f.store.dispose();
        // Source lifecycle policy is supplied by the daemon; archived is allowed,
        // deletion/retired is denied. Disposing a reader never writes a tombstone.
        const reader = new PortableContextStore(f.options); cleanups.push(() => reader.dispose());
        expect((await reader.exportPage({})).chunk === raw).toBe(true);
        const pending = reader.exportPage({});
        const rejected = expect(pending).rejects.toThrow('archived');
        f.allowed(false); await reader.invalidateForLifecycle(); await rejected;
        f.allowed(true); await reader.dispose();
        const reopened = new PortableContextStore(f.options); cleanups.push(() => reopened.dispose());
        expect((await reopened.exportPage({})).descriptor.sha256).toBe(digest(raw));
    });

    it('rejects cached export while the live store is clearing and after a separate reader observes its durable tombstone', async () => {
        const f = await fixture(); const value = archive('frozen'.repeat(20000));
        f.hint(await uploadRaw(f.store, JSON.stringify(value), value.snapshot.id));
        const reader = new PortableContextStore(f.options); cleanups.push(() => reader.dispose());
        const first = await reader.exportPage({}); // Warm the independent reader's old receipt/cache.
        expect(first.nextTextOffset).toBe(48000);
        await f.store.exportPage({});
        const pending = f.store.exportPage({ textOffset: first.nextTextOffset! }); const rejected = expect(pending).rejects.toThrow();
        const boundary = { id: randomUUID(), afterSeq: 11 };
        await f.store.revoke(boundary); await rejected;
        // Metadata CAS has not completed yet: the source callbacks still expose
        // the old hint/epoch. Only the on-disk authority proves revocation here.
        await expect(reader.exportPage({ textOffset: first.nextTextOffset! })).rejects.toThrow('replaced or cleared');
        f.boundary(boundary); f.hint(undefined);
        const restarted = new PortableContextStore(f.options); cleanups.push(() => restarted.dispose());
        await expect(restarted.exportPage({})).rejects.toThrow('cleared');
    });

    it('rejects stale chunks when another instance commits a new active descriptor without a public hint', async () => {
        const f = await fixture(); const original = archive('old');
        await uploadRaw(f.store, JSON.stringify(original), original.snapshot.id);
        const reader = new PortableContextStore(f.options); cleanups.push(() => reader.dispose());
        await reader.exportPage({});
        const replacement = archive('new');
        await uploadRaw(f.store, JSON.stringify(replacement), replacement.snapshot.id);
        await expect(reader.exportPage({})).rejects.toThrow('replaced or cleared');
    });

    it('rejects invalid offsets, explicit descriptor conflicts and identity-key changes', async () => {
        const f = await fixture(); const value = archive('frozen'); const raw = JSON.stringify(value);
        const descriptor = await uploadRaw(f.store, raw, value.snapshot.id); f.hint(descriptor);
        for (const offset of [-1, 0.5, NaN, Infinity, raw.length + 1]) {
            await expect(f.store.exportPage({ textOffset: offset })).rejects.toThrow('offset');
        }
        expect(await f.store.exportPage({ textOffset: raw.length })).toMatchObject({ chunk: '', nextTextOffset: null });
        f.hint({ ...descriptor, sha256: '0'.repeat(64) });
        await expect(f.store.exportPage({})).rejects.toThrow('descriptor mismatch');
        f.hint(undefined);
        const wrongKey = new PortableContextStore({ ...f.options, encryptionKey: new Uint8Array(32).fill(99) });
        cleanups.push(() => wrongKey.dispose());
        await expect(wrongKey.exportPage({})).rejects.toThrow('No committed');
    });
});
