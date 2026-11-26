import { buildHtmlFilePreview as buildStaticHtmlFilePreview } from './htmlPreviewBundle';
import { resolvePreviewPath } from './previewResources';
import { encodeBase64 } from '@/encryption/base64';
import { t } from '@/text';
import { createHtmlPreviewImageBridgeScript } from './htmlPreviewImageBridge.web';

const imageMime: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp' };

/** Adds scoped, event-driven image reads to the Web-only interactive sandbox. */
export async function buildHtmlFilePreview(content: string, path: string, root: string, read: (path: string) => Promise<Uint8Array>) {
    const bundle = await buildStaticHtmlFilePreview(content, path, root, read);
    const channel = crypto.randomUUID();
    let disposed = false;
    // Runtime galleries reuse a bounded LRU instead of the static bundle's
    // lifetime asset count. Reads happen only when the document assigns a URL.
    const images = new Map<string, string>();
    const pendingImages = new Map<string, Promise<string>>();
    const waiting: { start: () => void; reject: (error: Error) => void }[] = [];
    let imageCharacters = 0;
    let activeReads = 0;
    const acquire = () => new Promise<void>((resolve, reject) => {
        const start = () => { activeReads++; resolve(); };
        if (activeReads < 4) start(); else waiting.push({ start, reject });
    });
    const dispose = () => {
        disposed = true; bundle.dispose();
        images.clear(); imageCharacters = 0;
        for (const entry of waiting.splice(0)) entry.reject(new Error('Preview disposed'));
    };
    const readImage = async (reference: string) => {
        if (disposed) throw new Error('Preview disposed');
        const target = resolvePreviewPath(reference, path, root);
        if (!/\.(png|jpe?g|gif|webp|svg|avif|ico|bmp)$/i.test(target.path)) throw new Error('Unsupported preview image');
        const cached = images.get(target.path);
        if (cached) {
            images.delete(target.path); images.set(target.path, cached);
            return cached + target.fragment;
        }
        let pending = pendingImages.get(target.path);
        if (!pending) {
            if (pendingImages.size >= 256) throw new Error(t('fileWorkspace.tooLarge'));
            pending = (async () => {
                await acquire();
                try {
                    if (disposed) throw new Error('Preview disposed');
                    const bytes = await read(target.path);
                    if (disposed) throw new Error('Preview disposed');
                    if (bytes.byteLength > 10 * 1024 * 1024) throw new Error(t('fileWorkspace.tooLarge'));
                    const url = `data:${imageMime[target.path.split('.').pop()!.toLowerCase()]};base64,${encodeBase64(bytes)}`;
                    // At most 128 URLs and 16M UTF-16 code units retained here.
                    while (images.size && (images.size >= 128 || imageCharacters + url.length > 16 * 1024 * 1024)) {
                        const oldest = images.keys().next().value!;
                        imageCharacters -= images.get(oldest)!.length; images.delete(oldest);
                    }
                    images.set(target.path, url); imageCharacters += url.length;
                    return url;
                } finally {
                    activeReads--;
                    waiting.shift()?.start();
                }
            })().finally(() => { pendingImages.delete(target.path); });
            pendingImages.set(target.path, pending);
        }
        return await pending + target.fragment;
    };
    const bridge = createHtmlPreviewImageBridgeScript(channel).replace(/<\/script/gi, '<\\/script');
    // The static builder owns this policy tag. Keep it before the bootstrap,
    // and bootstrap before any artifact script, without reparsing embedded data.
    const html = bundle.html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/i, policy => `${policy}<script>${bridge}</script>`);
    return { channel, readImage, html, dispose };
}
