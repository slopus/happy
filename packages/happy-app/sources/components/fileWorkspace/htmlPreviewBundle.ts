import * as css from 'css-tree';
import { t } from '@/text';
import { resolvePreviewPath } from './previewResources';
const mime = (path: string) => ({ css: 'text/css', js: 'text/javascript', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', woff: 'font/woff', woff2: 'font/woff2' }[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream');
/** Static local dependencies only. Never receives app credentials or a tool bridge. */
export async function buildHtmlFilePreview(content: string, path: string, root: string, read: (path: string) => Promise<Uint8Array>) {
    const doc = new DOMParser().parseFromString(content, 'text/html');
    const urls: string[] = [], cache = new Map<string, Promise<Uint8Array>>();
    let total = 0;
    const dispose = () => urls.forEach(url => URL.revokeObjectURL(url));
    const load = (file: string) => {
        if (!cache.has(file)) {
            if (cache.size >= 128) throw new Error(t('fileWorkspace.tooLarge'));
            cache.set(file, read(file).then(bytes => { total += bytes.byteLength; if (total > 32 * 1024 * 1024) throw new Error(t('fileWorkspace.tooLarge')); return bytes; }));
        }
        return cache.get(file)!;
    };
    const resource = async (reference: string, owner: string) => {
        if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(reference)) return reference;
        const target = resolvePreviewPath(reference, owner, root);
        const bytes = await load(target.path);
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime(target.path) }));
        urls.push(url); return url + target.fragment;
    };
    const stylesheet = async (text: string, owner: string, declarations = false) => {
        const tree = css.parse(text, { context: declarations ? 'declarationList' : 'stylesheet' });
        const resources: css.Url[] = [];
        css.walk(tree, node => {
            if (node.type === 'Atrule' && node.name.toLowerCase() === 'import') throw new Error(t('fileWorkspace.unsupported'));
            if (node.type === 'Url') resources.push(node);
        });
        for (const node of resources) if (!node.value.startsWith('#')) node.value = await resource(node.value, owner);
        return css.generate(tree);
    };
    try {
        if (doc.querySelector('script[type="module"], [srcset]')) throw new Error(t('fileWorkspace.unsupported'));
        doc.querySelectorAll('base,iframe,object,embed,meta[http-equiv]').forEach(node => node.remove());
        for (const node of Array.from(doc.querySelectorAll('style'))) node.textContent = await stylesheet(node.textContent ?? '', path);
        for (const link of Array.from(doc.querySelectorAll<HTMLLinkElement>('link'))) {
            if (link.rel !== 'stylesheet') { link.remove(); continue; }
            const target = resolvePreviewPath(link.getAttribute('href') ?? '', path, root);
            const style = doc.createElement('style'); style.textContent = await stylesheet(new TextDecoder().decode(await load(target.path)), target.path);
            link.replaceWith(style);
        }
        for (const node of Array.from(doc.querySelectorAll<HTMLElement>('[style]'))) node.setAttribute('style', await stylesheet(node.getAttribute('style') ?? '', path, true));
        for (const node of Array.from(doc.querySelectorAll<HTMLElement>('[src]'))) {
            if (node.tagName === 'SCRIPT') {
                const target = resolvePreviewPath(node.getAttribute('src') ?? '', path, root);
                const source = new TextDecoder('utf-8', { fatal: true }).decode(await load(target.path));
                // A sandbox without same-origin access must not depend on being
                // able to request its parent's Blob script URL. Embed bytes read
                // by the scoped RPC; execution remains behind Run interaction.
                const code = node.hasAttribute('defer')
                    ? `document.addEventListener("DOMContentLoaded",function(){const script=document.createElement("script");script.textContent=${JSON.stringify(source)};document.body.appendChild(script)},{once:true});`
                    : source;
                node.removeAttribute('src');
                node.textContent = code.replace(/<\/script/gi, '<\\/script');
            } else node.setAttribute('src', await resource(node.getAttribute('src') ?? '', path));
        }
        doc.querySelectorAll('a[href]').forEach(node => { if (!node.getAttribute('href')?.startsWith('#')) node.removeAttribute('href'); });
        const policy = doc.createElement('meta'); policy.httpEquiv = 'Content-Security-Policy';
        policy.content = "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline' blob:; img-src blob: data:; font-src blob:; media-src blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
        doc.head.prepend(policy);
        return { html: '<!doctype html>' + doc.documentElement.outerHTML, dispose };
    } catch (error) { dispose(); throw error; }
}
