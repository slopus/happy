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
    it('loads CSS-relative images once, keeps inline interaction, and revokes all resource URLs', async () => {
        const read = vi.fn(async (path: string) => {
            if (path === '/work/demo/css/style.css') return encode('body { background: url(../image.png); }');
            if (path === '/work/demo/image.png') return encode('image');
            if (path === '/work/demo/app.js') return encode('document.body.onclick=()=>{}');
            throw new Error('Unexpected read ' + path);
        });
        const result = await buildHtmlFilePreview('<link rel="stylesheet" href="css/style.css"><script src="app.js"></script><button onclick="this.textContent=\'done\'">go</button>', '/work/demo/index.html', '/work', read);
        expect(read.mock.calls.map(call => call[0])).toEqual(['/work/demo/css/style.css', '/work/demo/image.png', '/work/demo/app.js']);
        expect(result.html).toContain('blob:test-1');
        expect(result.html).toContain('connect-src');
        expect(result.html).toContain('onclick=');
        result.dispose(); expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    });
    it('rejects remote and escaping dependencies and revokes partial work on error', async () => {
        const read = vi.fn(async () => encode('x'));
        await expect(buildHtmlFilePreview('<img src="ok.png"><script src="https://evil/x.js"></script>', '/work/index.html', '/work', read)).rejects.toThrow();
        expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
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
    expect(doc.querySelector('script[src]')).toBeNull();
    expect(doc.querySelector('#unexpected')).toBeNull();
    expect(doc.querySelector('script')?.textContent).toContain('dataset.version');
    expect(doc.querySelector('script')?.textContent).toContain('DOMContentLoaded');
    result.dispose();
});
