/** Bounded resource transfer for one owner. Native connection URLs stay on the execution machine. */
import { z } from 'zod';
import { MotionStudioAssetSchema, type MotionStudioOpen } from '@slopus/happy-wire';
import type { motionWorkbenchRequest } from '@/sync/motionWorkbench.web';

export type StudioAssetBytes = { id: string; mime: string; bytes: ArrayBuffer };
export type StudioBundle = { script: string; css: string; licenseText: string; runtimeVersion: string };
const bundleSchema = z.object({ script: z.string().min(1), css: z.string(), licenseText: z.string(), runtimeVersion: z.literal('0.1.8') });
const nativeAssetSchema = z.object({ reference: z.object({ $asset: z.string() }), mime: z.string(), bytes: z.number() });
const bufferOf = (bytes: Uint8Array): ArrayBuffer => { const buffer = new ArrayBuffer(bytes.length); new Uint8Array(buffer).set(bytes); return buffer; };
async function hash(bytes: Uint8Array): Promise<string> {
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bufferOf(bytes))), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function createStudioClient(sessionId: string, isCurrent: () => boolean, rpc: typeof motionWorkbenchRequest) {
    let descriptor: MotionStudioOpen | undefined, closed = false, loadedBytes = 0, started = false;
    const plannedBindingId = crypto.randomUUID();
    const assets = new Map<string, StudioAssetBytes>();
    const active = () => { if (closed || !isCurrent()) throw new Error('Motion project owner changed'); };
    async function resource(resourceId: string, bytes: number, expectedHash: string): Promise<Uint8Array> {
        active();
        if (!descriptor || bytes < 0 || bytes > 64 * 1024 * 1024) throw new Error('Invalid editor resource');
        const output = new Uint8Array(bytes);
        // Known content length bounds this transfer. There are no status queries or retries.
        for (let offset = 0; offset < bytes;) {
            active();
            const chunk = await rpc(sessionId, 'motionWorkbenchResource', { bindingId: descriptor.bindingId, resourceId, offset });
            active();
            const decoded = Uint8Array.from(atob(chunk.dataBase64), character => character.charCodeAt(0));
            if (chunk.offset !== offset || chunk.totalBytes !== bytes || decoded.length === 0 || decoded.length > 256 * 1024 || offset + decoded.length > bytes
                || chunk.done !== (offset + decoded.length === bytes)) throw new Error('Invalid editor resource chunk');
            output.set(decoded, offset); offset += decoded.length;
        }
        if (await hash(output) !== expectedHash) throw new Error('Editor resource integrity failed');
        return output;
    }
    async function loadAssets(input: unknown): Promise<StudioAssetBytes[]> {
        const parsed = z.array(nativeAssetSchema).max(2000).parse(input);
        const references = parsed.map(asset => MotionStudioAssetSchema.parse({ id: asset.reference.$asset, mime: asset.mime, bytes: asset.bytes }));
        if (references.reduce((total, asset) => total + asset.bytes, 0) > 128 * 1024 * 1024) throw new Error('Project assets exceed the editor memory limit');
        const missing = references.filter(asset => !assets.has(asset.id));
        const additional = missing.reduce((total, asset) => total + asset.bytes, 0);
        if (loadedBytes + additional > 128 * 1024 * 1024) throw new Error('Reopen the editor to release previous asset versions');
        loadedBytes += additional;
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(4, missing.length) }, async () => {
            for (;;) {
                const asset = missing[next++]; if (!asset) return;
                const bytes = await resource('asset:' + asset.id, asset.bytes, asset.id);
                active(); assets.set(asset.id, { id: asset.id, mime: asset.mime, bytes: bufferOf(bytes) });
            }
        }));
        return missing.map(asset => assets.get(asset.id)!);
    }
    async function prepareState(input: unknown): Promise<StudioAssetBytes[]> {
        const parsed = z.object({ assets: z.unknown() }).passthrough().safeParse(input);
        if (parsed.success) return loadAssets(parsed.data.assets);
        const nested = z.object({ state: z.object({ assets: z.unknown() }).passthrough() }).safeParse(input);
        return nested.success ? loadAssets(nested.data.state.assets) : [];
    }
    return {
        async open(projectPath: string) {
            active();
            started = true;
            const opened = await rpc(sessionId, 'motionWorkbenchOpen', { projectPath, bindingId: plannedBindingId });
            if (opened.bindingId !== plannedBindingId) throw new Error('Editor binding does not match this owner');
            if (closed || !isCurrent()) { void rpc(sessionId, 'motionWorkbenchClose', { bindingId: plannedBindingId }).catch(() => {}); active(); }
            descriptor = opened;
            const compressed = await resource('bundle', opened.bundle.bytes, opened.bundle.sha256);
            const reader = new Blob([bufferOf(compressed)]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
            const chunks: Uint8Array[] = []; let size = 0;
            try {
                for (;;) {
                    const chunk = await reader.read(); if (chunk.done) break;
                    size += chunk.value.length; if (size > 24 * 1024 * 1024) throw new Error('Editor bundle exceeds its decompression limit');
                    chunks.push(chunk.value);
                }
            } finally { await reader.cancel().catch(() => {}); }
            const bytes = new Uint8Array(size); let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
            const bundle = bundleSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
            const loaded = await loadAssets(opened.assets.map(asset => ({ reference: { $asset: asset.id }, mime: asset.mime, bytes: asset.bytes })));
            active(); return { descriptor: opened, bundle, assets: loaded };
        },
        async state() {
            active(); if (!descriptor) throw new Error('Editor is not open');
            const value = await rpc(sessionId, 'motionWorkbenchState', { bindingId: descriptor.bindingId });
            active(); return { value, assets: await prepareState(value) };
        },
        async operation(input: unknown) {
            active(); if (!descriptor) throw new Error('Editor is not open');
            const request = z.object({ route: z.string().min(1).max(256), body: z.record(z.string(), z.unknown()).optional() }).strict().parse(input);
            const value = await rpc(sessionId, 'motionWorkbenchOperation', { ...request, bindingId: descriptor.bindingId });
            active(); return { value, assets: await prepareState(value) };
        },
        getDescriptor: () => descriptor,
        getBindingId: () => plannedBindingId,
        async close() {
            if (closed) return true; closed = true; assets.clear();
            if (!started) return true;
            try { await rpc(sessionId, 'motionWorkbenchClose', { bindingId: plannedBindingId }); return true; } catch { return false; }
        },
    };
}

export function motionStudioFrameHtml(bundle: StudioBundle, channelNonce: string): string {
    z.string().uuid().parse(channelNonce);
    const csp = "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' blob:; style-src 'unsafe-inline' blob:; img-src blob: data:; media-src blob: data:; font-src blob: data:; connect-src blob: data:; worker-src blob:; object-src 'none'; base-uri 'none'; form-action 'none'";
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="paws-motion-channel" content="${channelNonce}"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}${bundle.css.replace(/<\/style/gi, '<\\/style')}</style></head><body><div id="root"></div><script type="module">${bundle.script.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
}
