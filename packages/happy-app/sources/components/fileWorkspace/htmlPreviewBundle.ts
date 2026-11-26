import * as css from 'css-tree';
import { t } from '@/text';
import { resolvePreviewPath } from './previewResources';
import { encodeBase64 } from '@/encryption/base64';
const mime = (path: string) => ({ css: 'text/css', js: 'text/javascript', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', woff: 'font/woff', woff2: 'font/woff2', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg' }[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream');
// Keep active document/script MIME types out of the resource path. These data
// URLs are consumed only as images, fonts or media, under the same restrictive CSP.
const embeddedResource = /^data:(?:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml)|font\/(?:woff2?|ttf|otf|sfnt)|application\/(?:font-woff|vnd\.ms-fontobject|x-font-ttf|x-font-opentype)|audio\/(?:mpeg|mp3|wav|x-wav|ogg|webm|mp4)|video\/(?:mp4|webm|ogg))(?:;[^,]*)?,/i;
// STYLE is HTML raw text even when assigned through textContent. Escape only
// closing-tag slashes: CSS unescapes them to the original string/URL contents,
// while comparison operators such as @media (width < 600px) stay unchanged.
const styleText = (text: string) => text.replace(/<\/style/gi, match => match.replace('/', '\\/'));
/** Static local dependencies only. Never receives app credentials or a tool bridge. */
export async function buildHtmlFilePreview(content: string, path: string, root: string, read: (path: string) => Promise<Uint8Array>) {
    const doc = new DOMParser().parseFromString(content, 'text/html');
    const cache = new Map<string, Promise<Uint8Array>>();
    let total = 0;
    const dispose = () => {}; // Embedded data has no parent-origin object URLs to retain.
    const load = (file: string) => {
        if (!cache.has(file)) {
            if (cache.size >= 128) throw new Error(t('fileWorkspace.tooLarge'));
            cache.set(file, read(file).then(bytes => { total += bytes.byteLength; if (total > 32 * 1024 * 1024) throw new Error(t('fileWorkspace.tooLarge')); return bytes; }));
        }
        return cache.get(file)!;
    };
    const resource = async (reference: string, owner: string) => {
        if (embeddedResource.test(reference)) return reference;
        const target = resolvePreviewPath(reference, owner, root);
        const bytes = await load(target.path);
        // Opaque sandbox frames cannot fetch Blob URLs owned by the parent.
        return `data:${mime(target.path)};base64,${encodeBase64(bytes)}` + target.fragment;
    };
    const stylesheet = async (text: string, owner: string, declarations = false) => {
        const tree = css.parse(text, { context: declarations ? 'declarationList' : 'stylesheet', parseCustomProperty: true });
        const resources: (css.Url | css.StringNode)[] = [];
        css.walk(tree, node => {
            if (node.type === 'Atrule' && node.name.toLowerCase() === 'import') throw new Error(t('fileWorkspace.unsupported'));
            if (node.type === 'Url') resources.push(node);
            if (node.type === 'Function' && /^(?:-webkit-)?image-set$/i.test(node.name)) {
                // Only direct strings are image candidates; strings nested in
                // type("image/webp") and unrelated content text are not URLs.
                node.children.forEach(child => { if (child.type === 'String') resources.push(child); });
            }
        });
        for (const node of resources) if (!node.value.startsWith('#')) node.value = await resource(node.value, owner);
        return css.generate(tree);
    };
    try {
        if (doc.querySelector('script[type="module"], [srcset]')) throw new Error(t('fileWorkspace.unsupported'));
        doc.querySelectorAll('base,iframe,object,embed,meta[http-equiv]').forEach(node => node.remove());
        for (const node of Array.from(doc.querySelectorAll('style'))) node.textContent = styleText(await stylesheet(node.textContent ?? '', path));
        for (const link of Array.from(doc.querySelectorAll<HTMLLinkElement>('link'))) {
            if (link.rel !== 'stylesheet') { link.remove(); continue; }
            const target = resolvePreviewPath(link.getAttribute('href') ?? '', path, root);
            const style = doc.createElement('style');
            for (const attribute of Array.from(link.attributes)) {
                if (attribute.name !== 'href' && attribute.name !== 'rel') style.setAttribute(attribute.name, attribute.value);
            }
            style.textContent = styleText(await stylesheet(new TextDecoder().decode(await load(target.path)), target.path));
            link.replaceWith(style);
        }
        for (const node of Array.from(doc.querySelectorAll<HTMLElement>('[style]'))) node.setAttribute('style', await stylesheet(node.getAttribute('style') ?? '', path, true));
        for (const node of Array.from(doc.querySelectorAll<HTMLElement>('[src]'))) {
            if (node.tagName === 'SCRIPT') {
                const target = resolvePreviewPath(node.getAttribute('src') ?? '', path, root);
                const source = await load(target.path);
                // A sandbox without same-origin access must not depend on being
                // able to request its parent's Blob script URL. A data script
                // retains native defer/async parser scheduling and original
                // bytes, including literals containing HTML closing tags.
                node.setAttribute('src', `data:text/javascript;charset=utf-8;base64,${encodeBase64(source)}`);
                node.textContent = '';
            } else node.setAttribute('src', await resource(node.getAttribute('src') ?? '', path));
        }
        for (const node of Array.from(doc.querySelectorAll<HTMLVideoElement>('video[poster]'))) node.setAttribute('poster', await resource(node.getAttribute('poster') ?? '', path));
        doc.querySelectorAll('a[href]').forEach(node => { if (!node.getAttribute('href')?.startsWith('#')) node.removeAttribute('href'); });
        const policy = doc.createElement('meta'); policy.httpEquiv = 'Content-Security-Policy';
        policy.content = "default-src 'none'; script-src 'unsafe-inline' blob: data:; style-src 'unsafe-inline' blob:; img-src blob: data:; font-src blob: data:; media-src blob: data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
        doc.head.prepend(policy);
        return { html: '<!doctype html>' + doc.documentElement.outerHTML, dispose };
    } catch (error) { dispose(); throw error; }
}
