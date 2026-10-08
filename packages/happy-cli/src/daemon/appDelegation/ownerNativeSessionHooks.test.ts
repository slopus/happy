/** Exercises the actual SDK bridge against an encrypted HTTP/socket fixture. */
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeBase64, decrypt, encodeBase64, encrypt, encryptBlob } from '@/api/encryption';
import { deriveKey } from '@/utils/deriveKey';
import { createOwnerNativeSessionHooks } from './ownerNativeSessionHooks';
import type { NativeMessage } from './nativeSessionRuntime';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(variant: 'legacy' | 'dataKey') {
    const key = new Uint8Array(32).fill(4), otherKey = new Uint8Array(32).fill(8);
    const seal = (value: unknown) => encodeBase64(encrypt(key, variant, value));
    const record = (id: string) => ({ id, seq: 0, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
        metadata: seal({ machineId: 'owner-machine', application: { appId: 'advisor', bindingId: 'binding' } }),
        metadataVersion: 1, agentState: null, agentStateVersion: 0, daemonState: null, daemonStateVersion: 0,
        dataEncryptionKey: variant === 'dataKey' ? 'opaque-owner-encrypted-key' : null });
    const state = { scoped: true, permitted: true, rows: [] as Array<{ id: string; seq: number; localId: string; content: { t: string; c: string }; createdAt: number; updatedAt: number }>,
        rpc: [] as string[], requests: [] as string[], unauthorized: false, rpcError: false,
        attachment: new Uint8Array() as Uint8Array, uploads: [] as Buffer[], oversized: false, oversizedStream: false, revokeDuringDownload: false, externalUrl: '' };
    const server = createServer(async (request, response) => {
        state.requests.push(`${request.method} ${request.url}`);
        const authorized = request.headers.authorization === 'Bearer owner-token';
        state.unauthorized ||= !authorized;
        response.setHeader('Content-Type', 'application/json');
        if (!authorized || !state.permitted) { response.writeHead(403); response.end('{}'); return; }
        const url = new URL(request.url!, 'http://fixture');
        if (url.pathname === '/v1/machines') response.end(JSON.stringify([record('owner-machine'), record('other-machine')]));
        else if (url.pathname === '/v1/sessions') response.end(JSON.stringify({ sessions: [record('owner-session'), record('other-session')] }));
        else if (url.pathname.startsWith('/v2/sessions/')) response.end(JSON.stringify({ session: record(url.pathname.split('/').at(-1)!) }));
        else if (url.pathname.endsWith('/attachments/request-upload')) {
            let body = ''; for await (const chunk of request) body += chunk;
            const {filename}=JSON.parse(body);
            response.end(JSON.stringify({ref:`sessions/owner-session/attachments/${filename}.enc`,method:'PUT',uploadUrl:`http://127.0.0.1:${(server.address() as { port: number }).port}/upload`}));
        } else if (url.pathname === '/upload') {
            const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(chunk);state.uploads.push(Buffer.concat(chunks));response.end('{}');
        } else if (url.pathname.endsWith('/attachments/request-download')) {
            let body = ''; for await (const chunk of request) body += chunk;
            expect(JSON.parse(body).ref).toBe('sessions/owner-session/attachments/image.enc');
            response.end(JSON.stringify({ downloadUrl: state.externalUrl || `http://127.0.0.1:${(server.address() as { port: number }).port}/blob` }));
        } else if (url.pathname === '/blob') {
            response.setHeader('Content-Type', 'application/octet-stream');
            if (state.oversized) response.setHeader('Content-Length', 11 * 1024 * 1024);
            if (state.oversizedStream) { response.write(new Uint8Array(1024)); response.end(new Uint8Array(10 * 1024 * 1024)); }
            else response.end(state.attachment);
            if (state.revokeDuringDownload) state.scoped = false;
        }
        else if (url.pathname.endsWith('/messages')) {
            if (request.method === 'POST') {
                let body = ''; for await (const chunk of request) body += chunk;
                for (const row of JSON.parse(body).messages) {
                    state.rows.push({ ...row, id: `row-${state.rows.length}`, seq: state.rows.length + 1, content: { t: 'encrypted', c: row.content }, createdAt: 1, updatedAt: 1 });
                }
                response.end('{}');
            } else {
                const after = Number(url.searchParams.get('after_seq'));
                response.end(JSON.stringify({ messages: state.rows.filter(row => row.seq > after), hasMore: false }));
            }
        } else { response.writeHead(404); response.end('{}'); }
    });
    const io = new Server(server, { path: '/v1/updates', transports: ['websocket'] });
    io.on('connection', socket => socket.on('rpc-call', (payload, acknowledge) => {
        state.rpc.push(payload.method);
        expect(decrypt(key, variant, decodeBase64(payload.params))).toEqual({});
        acknowledge(state.rpcError ? { ok: false, error: 'RPC failed' } : { ok: true, result: seal({}) });
    }));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const start = vi.fn(async () => ({ type: 'success' as const, sessionId: 'owner-session' }));
    const hooks = createOwnerNativeSessionHooks({
        serverUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        credentials: { token: 'owner-token', encryption: variant === 'legacy' ? { type: 'legacy', secret: key } : { type: 'dataKey', publicKey: otherKey, machineKey: key } },
        machine: { id: 'owner-machine', encryptionKey: key, encryptionVariant: variant },
        resolveSessionEncryption: id => id === 'owner-session' && state.scoped ? { encryptionKey: key, encryptionVariant: variant } : null,
        start,
    });
    cleanups.push(async () => { await hooks.dispose(); await new Promise<void>(resolve => io.close(() => resolve())); });
    await hooks.connect();
    const png = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nZcAAAAASUVORK5CYII=', 'base64'));
    const blobKey = await deriveKey(key, 'Happy Blobs', [variant === 'legacy' ? 'master' : 'session']);
    state.attachment = encryptBlob(png, blobKey);
    return { hooks, state, start, io, seal, png };
}

describe('owner native SDK bridge', () => {
    it.each(['legacy', 'dataKey'] as const)('forwards encrypted %s text snapshots and releases the existing SDK subscription', async variant => {
        const f = await fixture(variant);
        const seen: string[] = [], control = new AbortController();
        const watch = await f.hooks.watch('owner-session', { afterSeq: 0, onMessage: () => {}, onError: error => { throw error; }, signal: control.signal,
            onTextDelta: event => seen.push(event.text) });
        const emit = (text: string) => f.io.emit('session-stream', { sid: 'owner-session', content: { t: 'encrypted', c: f.seal({ type: 'text-delta', turnId: 'turn', itemId: 'item', delta: text, text }) } });
        emit('early');
        await vi.waitFor(() => expect(seen).toEqual(['early']));
        control.abort();
        emit('after abort');
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(seen).toEqual(['early']);
        watch.unsubscribe();
    });

    it('sends twelve consented context images in one native user batch and rejects thirteen',async()=>{
        const f=await fixture('dataKey');
        const images=Array.from({length:12},(_,index)=>({name:`image-${index}`,mimeType:'image/png',bytes:f.png}));
        await f.hooks.send({sessionId:'owner-session',localId:'carry',text:'untrusted migrated context',images});
        expect(f.state.uploads).toHaveLength(12);expect(f.state.requests.filter(path=>path==='POST /v3/sessions/owner-session/messages')).toHaveLength(1);
        const page=await f.hooks.historyPage('owner-session',{afterSeq:0,limit:500});expect(page.messages).toHaveLength(13);
        expect(page.messages.at(-1)).toMatchObject({localId:'carry',content:{role:'user',content:{text:'untrusted migrated context'}}});
        expect(page.messages.slice(0,-1).every(message=>(message.content as any).content.data.ev.t==='file')).toBe(true);
        const before=f.state.requests.length;await expect(f.hooks.send({sessionId:'owner-session',localId:'too-many',text:'too many',images:[...images,images[0]]})).rejects.toMatchObject({code:'INVALID_ARGUMENT'});expect(f.state.requests).toHaveLength(before);
    });
    it.each(['legacy', 'dataKey'] as const)('reads encrypted %s image history through native attachment download', async variant => {
        const f = await fixture(variant);
        const image = await f.hooks.readImage!('owner-session', 'sessions/owner-session/attachments/image.enc', 'image/png');
        expect(image).toBe(`data:image/png;base64,${Buffer.from(f.png).toString('base64')}`);
        expect(f.state.requests).toContain('POST /v1/sessions/owner-session/attachments/request-download');
        expect(f.state.requests).toContain('GET /blob');
        expect(f.state.unauthorized).toBe(false);
    });
    it('rejects image refs outside the session and unsupported media without downloading', async () => {
        const f = await fixture('dataKey');
        const baseline = f.state.requests.length;
        for (const [ref, mime] of [
            ['sessions/other-session/attachments/image.enc', 'image/png'],
            ['sessions/owner-session/attachments/../image.enc', 'image/png'],
            ['sessions/owner-session/attachments/image.enc', 'image/svg+xml'],
        ]) await expect(f.hooks.readImage!('owner-session', ref, mime)).rejects.toThrow('invalid-request');
        expect(f.state.requests).toHaveLength(baseline);
    });
    it('rejects corrupt images, mismatched MIME and oversized downloads', async () => {
        const f = await fixture('legacy');
        await expect(f.hooks.readImage!('owner-session', 'sessions/owner-session/attachments/image.enc', 'image/jpeg')).rejects.toThrow('invalid-request');
        f.state.attachment[40] ^= 1;
        await expect(f.hooks.readImage!('owner-session', 'sessions/owner-session/attachments/image.enc', 'image/png')).rejects.toThrow('invalid-request');
        f.state.oversized = true;
        await expect(f.hooks.readImage!('owner-session', 'sessions/owner-session/attachments/image.enc', 'image/png')).rejects.toThrow('attachment-unavailable');
    });
    it('bounds image reads without Content-Length and rechecks scope after the download', async () => {
        const f = await fixture('dataKey');
        f.state.oversizedStream = true;
        await expect(f.hooks.readImage!('owner-session', 'sessions/owner-session/attachments/image.enc', 'image/png')).rejects.toThrow('attachment-unavailable');
        f.state.oversizedStream = false; f.state.revokeDuringDownload = true;
        await expect(f.hooks.readImage!('owner-session', 'sessions/owner-session/attachments/image.enc', 'image/png')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
    it('denies image history after ownership revocation and rejects unrelated unsigned download origins', async () => {
        const f = await fixture('dataKey');
        f.state.permitted = false;
        await expect(f.hooks.readImage!('owner-session', 'sessions/owner-session/attachments/image.enc', 'image/png')).rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect(f.state.requests).not.toContain('GET /blob');
        f.state.permitted = true;
        f.state.externalUrl = 'http://127.0.0.1:1/unrelated';
        await expect(f.hooks.readImage!('owner-session', 'sessions/owner-session/attachments/image.enc', 'image/png')).rejects.toThrow('attachment-unavailable');
        expect(f.state.requests).not.toContain('GET /blob');
    });
    it.each(['legacy', 'dataKey'] as const)('connects and sends/reads/watches using %s owner-process keys', async variant => {
        const f = await fixture(variant);
        expect((await f.hooks.get('owner-session')).metadata).toMatchObject({ machineId: 'owner-machine' });
        await f.hooks.send({ sessionId: 'owner-session', localId: 'request-1', text: 'hello' });
        const page = await f.hooks.historyPage('owner-session', { afterSeq: 0, limit: 500 });
        expect(page.messages).toMatchObject([{ localId: 'request-1', content: { role: 'user', content: { text: 'hello' } } }]);
        const messages: NativeMessage[] = [];
        const watch = await f.hooks.watch('owner-session', { afterSeq: 0, onMessage: row => messages.push(row), onError: error => { throw error; } });
        await f.hooks.send({ sessionId: 'owner-session', localId: 'request-2', text: 'next' });
        f.io.emit('update', { body: { t: 'new-message', sid: 'owner-session', message: f.state.rows[1] } });
        await vi.waitFor(() => expect(messages.map(row => row.localId)).toEqual(['request-1', 'request-2']));
        await watch.sync();
        expect(messages).toHaveLength(2);
        watch.unsubscribe();
        expect(f.state.unauthorized).toBe(false);
    });
    it('rejects unknown keys and revoked scope even after caching a session', async () => {
        const f = await fixture('dataKey');
        await expect(f.hooks.get('other-session')).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await f.hooks.get('owner-session'); f.state.scoped = false;
        await expect(f.hooks.cancel('owner-session')).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(f.hooks.historyPage('owner-session', { afterSeq: 0, limit: 500 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect(f.state.rpc).toEqual([]);
    });
    it('rechecks server ownership before abort and never falls back to a different account', async () => {
        const f = await fixture('legacy');
        await f.hooks.get('owner-session'); f.state.permitted = false;
        await expect(f.hooks.cancel('owner-session')).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(f.hooks.send({ sessionId: 'owner-session', localId: 'denied', text: 'hello' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect(f.state.rpc).toEqual([]); expect(f.state.rows).toEqual([]);
    });
    it('uses native abort RPC without killing execution and surfaces RPC failures', async () => {
        const f = await fixture('dataKey');
        await f.hooks.cancel('owner-session');
        expect(f.state.rpc).toEqual(['owner-session:abort']);
        expect((await f.hooks.get('owner-session')).active).toBe(true);
        f.state.rpcError = true;
        await expect(f.hooks.cancel('owner-session')).rejects.toMatchObject({ code: 'UNKNOWN' });
        expect(f.state.rpc).toEqual(['owner-session:abort', 'owner-session:abort']);
    });
    it('passes lifecycle binding and grant unchanged to trusted start policy', async () => {
        const f = await fixture('dataKey');
        const input = { binding: { id: 'binding' }, codexSessionGrant: 'fixture-grant', systemPrompt: 'advisor prompt', directory: '/fixture' } as Parameters<typeof f.hooks.start>[0];
        await f.hooks.start(input);
        expect(f.start).toHaveBeenCalledExactlyOnceWith(input);
    });
});
