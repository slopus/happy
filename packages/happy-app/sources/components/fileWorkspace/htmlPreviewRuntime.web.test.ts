// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
vi.mock('@/text', () => ({ t: (key: string) => key }));
import { buildHtmlFilePreview } from './htmlPreviewRuntime.web';
const encode = (text: string) => new TextEncoder().encode(text);

it('reads dynamically assigned local images on demand, including galleries over 128 assets', async () => {
    const read = vi.fn(async () => encode('image'));
    const result = await buildHtmlFilePreview('<script>window.draw=()=>{}</script>', '/work/demo/index.html', '/work', read);
    expect(read).not.toHaveBeenCalled();
    expect(result).toHaveProperty('readImage', expect.any(Function));
    for (let index = 0; index < 258; index++) {
        expect(await result.readImage(`images/${index}.webp`)).toBe('data:image/webp;base64,aW1hZ2U=');
    }
    expect(read).toHaveBeenCalledTimes(258);
    await result.readImage('images/257.webp');
    expect(read).toHaveBeenCalledTimes(258);
    result.dispose();
    await expect(result.readImage('images/new.webp')).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(258);
});

it('rejects out-of-scope and non-image dynamic requests before reading bytes', async () => {
    const read = vi.fn(async () => encode('image'));
    const result = await buildHtmlFilePreview('', '/work/demo/index.html', '/work', read);
    expect(result).toHaveProperty('readImage', expect.any(Function));
    for (const reference of ['../../secret.png', 'https://example.com/a.png', '//example.com/a.png', 'data:image/png;base64,eA==', 'app.js', 'private.txt', 'file:///private.png']) {
        await expect(result.readImage(reference)).rejects.toThrow();
    }
    expect(read).not.toHaveBeenCalled();
    result.dispose();
});

it('deduplicates image reads and discards a result that finishes after disposal', async () => {
    let finish!: (bytes: Uint8Array) => void;
    const read = vi.fn(() => new Promise<Uint8Array>(resolve => { finish = resolve; }));
    const result = await buildHtmlFilePreview('', '/work/index.html', '/work', read);
    expect(result).toHaveProperty('readImage', expect.any(Function));
    const one = result.readImage('image.png');
    const two = result.readImage('./image.png');
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
    result.dispose();
    finish(encode('image'));
    await expect(one).rejects.toThrow();
    await expect(two).rejects.toThrow();
});


it('puts the scoped bootstrap after CSP and before artifact scripts', async () => {
    const result = await buildHtmlFilePreview('<script>window.artifact=true</script>', '/work/index.html', '/work', async () => encode(''));
    expect(result.html.indexOf('Content-Security-Policy')).toBeLessThan(result.html.indexOf('paws-preview-image-request'));
    expect(result.html.indexOf('paws-preview-image-request')).toBeLessThan(result.html.indexOf('window.artifact=true'));
    expect(result.html).toContain("connect-src 'none'");
    expect(result.html).toContain("img-src blob: data:");
    result.dispose();
});

it('bounds simultaneous execution-machine image reads and releases slots after failure', async () => {
    const gates: (() => void)[] = [];
    let active = 0, maximum = 0;
    const read = vi.fn(async (path: string) => {
        active++; maximum = Math.max(maximum, active);
        await new Promise<void>(resolve => gates.push(resolve));
        active--;
        if (path.endsWith('/0.png')) throw new Error('missing image');
        return encode('image');
    });
    const result = await buildHtmlFilePreview('', '/work/index.html', '/work', read);
    const requests = Array.from({ length: 12 }, (_, index) => result.readImage(`${index}.png`));
    const complete = Promise.allSettled(requests);
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(4);
    while (gates.length) {
        gates.splice(0).forEach(finish => finish());
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    const outcomes = await complete;
    expect(maximum).toBe(4);
    expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(11);
    result.dispose();
});
