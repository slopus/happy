import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MotionWorkbenchRequests, MotionWorkbenchResponses, type MotionStudioOpen } from '@slopus/happy-wire';
import type { motionWorkbenchRequest } from '@/sync/motionWorkbench.web';
import { createStudioClient, motionStudioFrameHtml } from './studioClient.web';

type Method = keyof typeof MotionWorkbenchRequests;
function rpcFixture(handler: (method: Method, input: unknown) => Promise<unknown>): typeof motionWorkbenchRequest {
    return async function rpc<K extends Method>(_session: string, method: K, input: z.input<(typeof MotionWorkbenchRequests)[K]>): Promise<z.infer<(typeof MotionWorkbenchResponses)[K]>> {
        return await handler(method, input) as z.infer<(typeof MotionWorkbenchResponses)[K]>;
    };
}
const bundle = { script: 'globalThis.__pawsScriptExecuted=true;', css: 'body{}', licenseText: 'GNU GENERAL PUBLIC LICENSE', runtimeVersion: '0.1.8' };
const bytes = gzipSync(JSON.stringify(bundle));
const descriptor = (bindingId: string): MotionStudioOpen => ({ bindingId, projectId: 'a'.repeat(64), projectPath: '/owned/project', runtimeVersion: '0.1.8',
    state: { document: { revision: 1 } }, assets: [], bundle: { bytes: bytes.length, encoding: 'gzip', sha256: createHash('sha256').update(bytes).digest('hex') } });
const part = (offset = 0, content = bytes) => ({ offset, totalBytes: content.length, dataBase64: content.toString('base64'), done: true });

describe('isolated motion resource client', () => {
    it('decodes verified content as data and releases the exact planned owner', async () => {
        const closed: unknown[] = [];
        const client = createStudioClient('session', () => true, rpcFixture(async (method, input) => {
            if (method === 'motionWorkbenchOpen') return descriptor(MotionWorkbenchRequests.motionWorkbenchOpen.parse(input).bindingId!);
            if (method === 'motionWorkbenchResource') return part();
            if (method === 'motionWorkbenchClose') { closed.push(input); return { closed: true }; }
            throw new Error('Unexpected request');
        }));
        const opened = await client.open('.');
        expect(opened.bundle).toEqual(bundle);
        expect((globalThis as Record<string, unknown>).__pawsScriptExecuted).toBeUndefined();
        await client.close(); expect(closed).toEqual([{ bindingId: client.getBindingId() }]);
    });
    it.each(['offset', 'integrity'])('rejects corrupt %s responses before parsing any editor script', async kind => {
        const client = createStudioClient('session', () => true, rpcFixture(async (method, input) => {
            if (method === 'motionWorkbenchOpen') return descriptor(MotionWorkbenchRequests.motionWorkbenchOpen.parse(input).bindingId!);
            if (method === 'motionWorkbenchResource') return kind === 'offset' ? part(1) : part(0, Buffer.alloc(bytes.length));
            return { closed: true };
        }));
        await expect(client.open('.')).rejects.toThrow(kind === 'offset' ? 'chunk' : 'integrity'); await client.close();
    });
    it('rejects and closes an opening owner after the account/session generation changes', async () => {
        let current = true;
        const closed: unknown[] = [];
        const client = createStudioClient('session', () => current, rpcFixture(async (method, input) => {
            if (method === 'motionWorkbenchOpen') { current = false; return descriptor(MotionWorkbenchRequests.motionWorkbenchOpen.parse(input).bindingId!); }
            if (method === 'motionWorkbenchClose') { closed.push(input); return { closed: true }; }
            throw new Error('Stale owner must not read resources');
        }));
        await expect(client.open('.')).rejects.toThrow('owner changed');
        expect(closed).toEqual([{ bindingId: client.getBindingId() }]);
    });
    it('rejects a response for a different owner and never closes that foreign owner', async () => {
        const closed: unknown[] = [];
        const foreign = '00000000-0000-4000-8000-000000000000';
        const client = createStudioClient('session', () => true, rpcFixture(async (method, input) => {
            if (method === 'motionWorkbenchOpen') return descriptor(foreign);
            if (method === 'motionWorkbenchClose') { closed.push(input); return { closed: true }; }
            throw new Error('Foreign resources must not load');
        }));
        await expect(client.open('.')).rejects.toThrow('does not match'); await client.close();
        expect(closed).toEqual([{ bindingId: client.getBindingId() }]); expect(client.getBindingId()).not.toBe(foreign);
    });
    it('binds the child handshake and protects HTML delimiters with a constrained CSP', () => {
        const nonce = '00000000-0000-4000-8000-000000000001';
        const html = motionStudioFrameHtml({ ...bundle, script: 'const content="</script><img src=x>";', css: 'a::before{content:"</style>"}' }, nonce);
        expect(html).toContain('name="paws-motion-channel" content="' + nonce + '"');
        expect(html.match(/<\/script>/gi)).toHaveLength(1); expect(html.match(/<\/style>/gi)).toHaveLength(1);
        expect(html).toContain("connect-src blob: data:"); expect(html).toContain("form-action 'none'");
        expect(() => motionStudioFrameHtml(bundle, 'untrusted" nonce')).toThrow();
    });
});
