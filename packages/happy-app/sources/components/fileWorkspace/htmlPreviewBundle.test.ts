// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/text', () => ({ t: (key: string) => key }));
import { buildHtmlFilePreview } from './htmlPreviewBundle';
const encode = (text: string) => new TextEncoder().encode(text);
beforeEach(() => {
    let id = 0;
    URL.createObjectURL = vi.fn(() => `blob:test-${++id}`);
    URL.revokeObjectURL = vi.fn();
});
describe('isolated HTML bundle', () => {
    it('embeds CSS-relative images for an opaque sandbox without parent Blob URLs', async () => {
        const read = vi.fn(async (path: string) => {
            if (path === '/work/demo/css/style.css') return encode('body { background: url(../image.png); }');
            if (path === '/work/demo/image.png') return encode('image');
            if (path === '/work/demo/app.js') return encode('document.body.onclick=()=>{}');
            throw new Error('Unexpected read ' + path);
        });
        const result = await buildHtmlFilePreview('<link rel="stylesheet" href="css/style.css"><script src="app.js"></script><button onclick="this.textContent=\'done\'">go</button>', '/work/demo/index.html', '/work', read);
        expect(read.mock.calls.map(call => call[0])).toEqual(['/work/demo/css/style.css', '/work/demo/image.png', '/work/demo/app.js']);
        expect(result.html).toContain('data:image/png;base64,aW1hZ2U=');
        expect(URL.createObjectURL).not.toHaveBeenCalled();
        expect(result.html).toContain('connect-src');
        expect(result.html).toContain('onclick=');
        result.dispose(); expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    });
    it('rejects remote and escaping dependencies without creating parent-origin URLs', async () => {
        const read = vi.fn(async () => encode('x'));
        await expect(buildHtmlFilePreview('<img src="ok.png"><script src="https://evil/x.js"></script>', '/work/index.html', '/work', read)).rejects.toThrow();
        expect(URL.revokeObjectURL).not.toHaveBeenCalled();
        await expect(buildHtmlFilePreview('<img src="../private">', '/work/index.html', '/work', read)).rejects.toThrow();
        expect(read).toHaveBeenCalledTimes(1);
    });
    it('removes embedded browsing contexts and blocks forms and network connections in CSP', async () => {
        const result = await buildHtmlFilePreview('<base href="https://evil/"><iframe src="https://evil/"></iframe><meta http-equiv="refresh" content="0;url=https://evil/"><h1>Safe</h1>', '/work/index.html', '/work', async () => encode(''));
        expect(result.html).not.toContain('<iframe'); expect(result.html).not.toContain('<base'); expect(result.html).not.toContain('http-equiv="refresh"');
        expect(result.html).toContain("form-action 'none'"); expect(result.html).toContain("connect-src 'none'");
    });
});

it('embeds locally read classic script bytes without an opaque-frame blob request or a script closing escape', async () => {
    const source = 'document.body.dataset.version="v2"; const text="</script><p id=unexpected>escape</p>";';
    const result = await buildHtmlFilePreview('<html><head><script defer src="app.js"></script></head><body><p id="version">v1</p></body></html>', '/work/index.html', '/work', async () => encode(source));
    const doc = new DOMParser().parseFromString(result.html, 'text/html');
    const script = doc.querySelector('script[src]')!;
    expect(script.hasAttribute('defer')).toBe(true);
    const sourceUrl = script.getAttribute('src')!;
    expect(new TextDecoder().decode(Uint8Array.from(atob(sourceUrl.slice(sourceUrl.indexOf(',') + 1)), char => char.charCodeAt(0)))).toBe(source);
    expect(doc.querySelector('#unexpected')).toBeNull();
    expect(script.textContent).toBe('');
    result.dispose();
});

it('bundles local video sources and poster images with their media MIME types', async () => {
    const read = vi.fn(async () => encode('bytes'));
    const result = await buildHtmlFilePreview('<video poster="poster.jpg"><source src="film.mp4" type="video/mp4"></video>', '/work/index.html', '/work', read);
    const doc = new DOMParser().parseFromString(result.html, 'text/html');
    expect(doc.querySelector('video')?.getAttribute('poster')).toMatch(/^data:image\/jpeg;base64,/);
    expect(read).toHaveBeenCalledWith('/work/poster.jpg');
    expect(read).toHaveBeenCalledWith('/work/film.mp4');
    expect(doc.querySelector('source')?.getAttribute('src')).toMatch(/^data:video\/mp4;base64,/);
    expect(result.html).toContain('media-src blob: data:');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    result.dispose();
});

it('preserves arbitrary binary bytes in an embedded asset larger than an apply argument limit', async () => {
    const bytes = Uint8Array.from({ length: 100000 }, (_, i) => i % 256);
    const result = await buildHtmlFilePreview('<img src="image.png">', '/work/index.html', '/work', async () => bytes);
    const src = new DOMParser().parseFromString(result.html, 'text/html').querySelector('img')!.getAttribute('src')!;
    expect(Uint8Array.from(atob(src.slice(src.indexOf(',') + 1)), c => c.charCodeAt(0))).toEqual(bytes);
    result.dispose();
});
