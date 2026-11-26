import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import * as css from 'css-tree';

vi.mock('@/text', () => ({ t: (key: string) => key }));
import { buildHtmlFilePreview } from './htmlPreviewBundle';

const encode = (text: string) => new TextEncoder().encode(text);
const realms: JSDOM[] = [];
beforeEach(() => {
    const parser = new JSDOM('');
    realms.push(parser);
    vi.stubGlobal('DOMParser', parser.window.DOMParser);
});
afterEach(() => {
    for (const realm of realms.splice(0)) realm.window.close();
    vi.unstubAllGlobals();
});

async function execute(html: string) {
    // Exercise the serialized artifact, including real external data-script
    // loading and parser/defer ordering, rather than manually evaluating code.
    const realm = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable', virtualConsole: new VirtualConsole() });
    realms.push(realm);
    await new Promise<void>(resolve => realm.window.addEventListener('load', () => resolve(), { once: true }));
    return realm.window;
}

function strings(text: string) {
    const values: string[] = [];
    css.walk(css.parse(text, { parseCustomProperty: true }), node => {
        if (node.type === 'String') values.push(node.value);
    });
    return values;
}

describe('bundled script scheduling', () => {
    it('executes deferred scripts in order with a body before the original DOMContentLoaded event', async () => {
        const sources: Record<string, string> = {
            '/work/first.js': 'events.push("first:"+!!document.body);document.addEventListener("DOMContentLoaded",()=>events.push("dcl:first"));',
            '/work/second.js': 'events.push("second");document.addEventListener("DOMContentLoaded",()=>events.push("dcl:second"));',
        };
        const result = await buildHtmlFilePreview('<script>window.events=[];document.addEventListener("DOMContentLoaded",()=>events.push("dcl:html"))</script><script defer src="first.js"></script><script defer src="second.js"></script><body><script>events.push("body")</script></body>', '/work/index.html', '/work', async path => encode(sources[path]));
        const window = await execute(result.html);
        expect(window.events).toEqual(['body', 'first:true', 'second', 'dcl:html', 'dcl:first', 'dcl:second']);
    });

    it('executes original script bytes containing closing tags without injecting markup', async () => {
        const literal = '</script><p id="unexpected">escape</p>中文';
        const source = `document.body.dataset.literal=${JSON.stringify(literal)};`;
        const result = await buildHtmlFilePreview('<script defer src="app.js"></script><body></body>', '/work/index.html', '/work', async () => encode(source));
        const window = await execute(result.html);
        expect(window.document.body.dataset.literal).toBe(literal);
        expect(window.document.querySelector('#unexpected')).toBeNull();
    });

    it('retains async scripts as external scripts that execute before window load', async () => {
        const result = await buildHtmlFilePreview('<script async src="app.js"></script>', '/work/index.html', '/work', async () => encode('document.documentElement.dataset.async="ran"'));
        const window = await execute(result.html);
        expect(window.document.documentElement.dataset.async).toBe('ran');
        expect(window.document.querySelector('script[async][src]')).not.toBeNull();
        expect(window.document.querySelector('meta')?.content).toContain("script-src 'unsafe-inline' blob: data:");
    });
});

describe('stylesheet serialization and resources', () => {
    it('keeps external stylesheet closing tags in CSS strings without creating executable HTML', async () => {
        const literal = '</StYlE><script>window.cssInjected=true</script><style>';
        const source = `body::after{content:${JSON.stringify(literal)}}@media (width < 600px){body{color:red}}`;
        const result = await buildHtmlFilePreview('<link rel="stylesheet" href="style.css"><body>artifact</body>', '/work/index.html', '/work', async () => encode(source));
        const window = await execute(result.html);
        expect(window.cssInjected).toBeUndefined();
        expect(window.document.querySelector('script')).toBeNull();
        const bundled = window.document.querySelector('style')!.textContent!;
        expect(strings(bundled)).toContain(literal);
        expect(bundled).toContain('width<600px');
    });

    it('keeps escaped closing tags in existing styles safe after CSS normalization', async () => {
        const result = await buildHtmlFilePreview('<style>body::after{content:"\\3c /style>\\3c script>window.cssInjected=true\\3c /script>"}</style><body></body>', '/work/index.html', '/work', async () => encode(''));
        const window = await execute(result.html);
        expect(window.cssInjected).toBeUndefined();
        expect(window.document.querySelector('script')).toBeNull();
        expect(strings(window.document.querySelector('style')!.textContent!)).toEqual(['</style><script>window.cssInjected=true</script>']);
    });

    it('resolves custom-property URLs and direct image-set strings relative to their stylesheet only', async () => {
        const source = 'body{--hero:url(../hero.png);background-image:image-set("../photo.webp" 1x type("image/webp"),url(../other.png) 2x);mask-image:-webkit-image-set("../mask.png" 1x);content:"caption.png"}';
        const read = vi.fn(async (path: string) => encode(path.endsWith('.css') ? source : 'image'));
        const result = await buildHtmlFilePreview('<link rel="stylesheet" href="css/style.css">', '/work/index.html', '/work', read);
        expect(read.mock.calls.map(call => call[0])).toEqual(['/work/css/style.css', '/work/hero.png', '/work/photo.webp', '/work/other.png', '/work/mask.png']);
        const doc = new DOMParser().parseFromString(result.html, 'text/html');
        const bundled = doc.querySelector('style')!.textContent!;
        expect(strings(bundled)).toEqual(['data:image/webp;base64,aW1hZ2U=', 'image/webp', 'data:image/png;base64,aW1hZ2U=', 'caption.png']);
        const urls: string[] = [];
        css.walk(css.parse(bundled, { parseCustomProperty: true }), node => { if (node.type === 'Url') urls.push(node.value); });
        expect(urls).toEqual(['data:image/png;base64,aW1hZ2U=', 'data:image/png;base64,aW1hZ2U=']);
    });

    it.each(['image-set("https://example.com/image.webp" 1x)', '-webkit-image-set("../../secret.png" 1x)'])('keeps image-set dependencies behind the scoped path resolver: %s', async value => {
        const read = vi.fn(async () => encode('image'));
        await expect(buildHtmlFilePreview(`<style>body{background-image:${value}}</style>`, '/work/index.html', '/work', read)).rejects.toThrow();
        expect(read).not.toHaveBeenCalled();
    });

    it('preserves a stylesheet media restriction and its identity attributes when replacing a link', async () => {
        const result = await buildHtmlFilePreview('<link rel="stylesheet" href="print.css" media="print" id="print-theme" class="theme" title="Print" nonce="preview">', '/work/index.html', '/work', async () => encode('body{display:none}'));
        const doc = new DOMParser().parseFromString(result.html, 'text/html');
        const style = doc.querySelector('style')!;
        expect(style.media).toBe('print');
        expect(style.id).toBe('print-theme');
        expect(style.className).toBe('theme');
        expect(style.title).toBe('Print');
        expect(style.getAttribute('nonce')).toBe('preview');
    });
});

describe('self-contained data resources', () => {
    it.each([
        'data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22/%3E',
        'data:image/svg+xml;charset=utf-8;base64,PHN2Zy8+',
        'data:image/png,%89PNG%0D%0A',
        'data:image/avif;base64,eA==',
    ])('retains an allowed self-contained image without a filesystem read: %s', async reference => {
        const read = vi.fn(async () => encode('unexpected'));
        const result = await buildHtmlFilePreview(`<img src="${reference}">`, '/work/index.html', '/work', read);
        const doc = new DOMParser().parseFromString(result.html, 'text/html');
        expect(doc.querySelector('img')?.getAttribute('src')).toBe(reference);
        expect(read).not.toHaveBeenCalled();
    });

    it.each(['data:font/woff2;base64,eA==', 'data:font/woff2,%77%4f%46%32'])('retains a self-contained CSS font: %s', async reference => {
        const read = vi.fn(async () => encode('unexpected'));
        const result = await buildHtmlFilePreview(`<style>@font-face{font-family:preview;src:url("${reference}")}</style>`, '/work/index.html', '/work', read);
        const urls: string[] = [];
        const doc = new DOMParser().parseFromString(result.html, 'text/html');
        css.walk(css.parse(doc.querySelector('style')!.textContent!), node => { if (node.type === 'Url') urls.push(node.value); });
        expect(urls).toEqual([reference]);
        expect(read).not.toHaveBeenCalled();
        expect(doc.querySelector('meta')?.content).toContain("connect-src 'none'; frame-src 'none'; object-src 'none'");
    });

    it.each(['data:text/html,%3Cscript%3Ealert(1)%3C/script%3E', 'data:text/javascript,alert(1)', 'data:application/javascript;base64,YWxlcnQoMSk=', 'https://example.com/image.png', '//example.com/image.png'])('rejects active data and network resources: %s', async reference => {
        const read = vi.fn(async () => encode('unexpected'));
        await expect(buildHtmlFilePreview(`<img src="${reference}">`, '/work/index.html', '/work', read)).rejects.toThrow();
        expect(read).not.toHaveBeenCalled();
    });

    it('does not accept caller-supplied data scripts through the local script path', async () => {
        const read = vi.fn(async () => encode('unexpected'));
        await expect(buildHtmlFilePreview('<script src="data:text/javascript,alert(1)"></script>', '/work/index.html', '/work', read)).rejects.toThrow();
        expect(read).not.toHaveBeenCalled();
    });
});
