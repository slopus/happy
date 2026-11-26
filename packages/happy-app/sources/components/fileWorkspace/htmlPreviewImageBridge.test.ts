import { afterEach, describe, expect, it } from 'vitest';
import { JSDOM as Jsdom } from 'jsdom';
import { createHtmlPreviewImageBridgeScript } from './htmlPreviewImageBridge.web';

// Each fixture executes the generated source in its own browser realm.
const JSDOM: any = Jsdom;
type ImageRequest = { type: string; channel: string; id: number; reference: string };
const closeRealms: Array<() => void> = [];
const imageUrl = 'data:image/png;base64,aW1hZ2U=';
const flushMutations = async () => { await Promise.resolve(); await Promise.resolve(); };

function fixture(html = '') {
    const realm = new JSDOM(html, { runScripts: 'outside-only', url: 'https://preview.invalid/index.html' });
    const browser = realm.window;
    closeRealms.push(() => browser.close());
    const requests: ImageRequest[] = [];
    browser.parent.postMessage = (message: ImageRequest) => requests.push(message);
    browser.eval(createHtmlPreviewImageBridgeScript('channel-one'));
    const respond = (id: number, url: string | null = imageUrl, overrides: Record<string, unknown> = {}, source = browser.parent) => {
        browser.dispatchEvent(new browser.MessageEvent('message', {
            source,
            data: { type: 'paws-preview-image-response', channel: 'channel-one', id, ...(url ? { url } : {}), ...overrides },
        }));
    };
    return { browser, document: browser.document as Document, requests, respond };
}

afterEach(() => { closeRealms.splice(0).forEach(close => close()); });

describe('HTML preview image bridge', () => {
    it('requests existing images and dynamically inserted images and posters using their raw references', async () => {
        const page = fixture('<img src="assets/first.png">');
        expect(page.requests).toEqual([{ type: 'paws-preview-image-request', channel: 'channel-one', id: 1, reference: 'assets/first.png' }]);
        page.document.body.insertAdjacentHTML('beforeend', '<section><img src="../frames/图 2.jpg"><video src="film.mp4" poster="poster.jpg"></video></section>');
        await flushMutations();
        expect(page.requests.map(request => request.reference)).toEqual(['assets/first.png', '../frames/图 2.jpg', 'poster.jpg']);
        for (const request of page.requests) page.respond(request.id);
        await flushMutations();
        expect(Array.from(page.document.querySelectorAll('img')).map(image => image.getAttribute('src'))).toEqual([imageUrl, imageUrl]);
        expect(page.document.querySelector('video')?.getAttribute('poster')).toBe(imageUrl);
        expect(page.document.querySelector('video')?.getAttribute('src')).toBe('film.mp4');
        expect(page.requests).toHaveLength(3);
    });

    it('reads an Image with src assigned before insertion and an existing lazy image when its src is assigned', async () => {
        const page = fixture('<img id="lazy" data-src="lazy.jpg">');
        expect(page.requests).toHaveLength(0);
        const image = new page.browser.Image();
        image.src = 'frames/new.jpg';
        expect(page.requests).toHaveLength(0);
        page.document.body.append(image);
        page.document.querySelector('#lazy')!.setAttribute('src', 'lazy.jpg');
        await flushMutations();
        expect(page.requests.map(request => request.reference)).toEqual(['frames/new.jpg', 'lazy.jpg']);
    });

    it('does not let an older response replace a changed src even before its mutation is delivered', async () => {
        const page = fixture('<img src="first.jpg">');
        const image = page.document.querySelector('img')!;
        image.setAttribute('src', 'second.jpg');
        page.respond(page.requests[0].id);
        expect(image.getAttribute('src')).toBe('second.jpg');
        await flushMutations();
        expect(page.requests.map(request => request.reference)).toEqual(['first.jpg', 'second.jpg']);
        page.respond(page.requests[1].id);
        expect(image.getAttribute('src')).toBe(imageUrl);
    });

    it('keeps a successful image load when the same node is detached and later reinserted', async () => {
        const page = fixture('<img src="frames/one.png">');
        const image = page.document.querySelector('img')!;
        image.remove();
        await flushMutations();
        page.respond(page.requests[0].id);
        page.document.body.append(image);
        await flushMutations();
        expect(image.getAttribute('src')).toBe(imageUrl);
        expect(page.requests).toHaveLength(1);
    });

    it('does not retry a failed detached image when it is reinserted', async () => {
        const page = fixture('<img src="missing.png">');
        const image = page.document.querySelector('img')!;
        image.remove();
        await flushMutations();
        page.respond(page.requests[0].id, null);
        page.document.body.append(image);
        await flushMutations();
        expect(image.getAttribute('src')).toBe('missing.png');
        expect(page.requests).toHaveLength(1);
    });

    it('combines duplicate references while in flight without retaining completed child-side cache entries', async () => {
        const page = fixture('<img src="same.jpg"><img src="same.jpg">');
        expect(page.requests).toHaveLength(1);
        page.respond(page.requests[0].id);
        await flushMutations();
        expect(Array.from(page.document.querySelectorAll('img')).every(image => image.getAttribute('src') === imageUrl)).toBe(true);
        page.document.body.insertAdjacentHTML('beforeend', '<img src="same.jpg">');
        await flushMutations();
        expect(page.requests).toHaveLength(2);
    });

    it('ignores messages from another source or channel and responses with an unknown id', () => {
        const page = fixture('<img src="first.jpg">');
        const image = page.document.querySelector('img')!;
        page.respond(page.requests[0].id, imageUrl, {}, null);
        page.respond(page.requests[0].id, imageUrl, { channel: 'another-channel' });
        page.respond(999);
        expect(image.getAttribute('src')).toBe('first.jpg');
        page.respond(page.requests[0].id);
        expect(image.getAttribute('src')).toBe(imageUrl);
    });

    it('leaves data, Blob and network references alone and never requests empty sources', async () => {
        const page = fixture('<img src="data:image/png;base64,eA=="><img src="blob:null/test"><img src="https://host/image.jpg"><img src="//host/image.jpg"><img src="file:///tmp/image.jpg"><img src=""><img>');
        page.document.body.insertAdjacentHTML('beforeend', '<img src="  HTTP://host/another.jpg"><video poster="data:image/png;base64,eA=="></video>');
        await flushMutations();
        expect(page.requests).toHaveLength(0);
    });

    it('does not retry a failed image during unrelated DOM changes but permits an explicit src assignment', async () => {
        const page = fixture('<img src="missing.jpg">');
        page.respond(page.requests[0].id, null);
        page.document.body.insertAdjacentHTML('beforeend', '<div>unrelated</div>');
        await flushMutations();
        expect(page.requests).toHaveLength(1);
        page.document.querySelector('img')!.setAttribute('src', 'missing.jpg');
        await flushMutations();
        expect(page.requests).toHaveLength(2);
    });

    it('loads a 258-image gallery in FIFO order with at most 16 requests awaiting a response', async () => {
        const page = fixture();
        page.document.body.innerHTML = Array.from({ length: 258 }, (_, index) => `<img src="frames/${index}.jpg">`).join('');
        await flushMutations();
        expect(page.requests).toHaveLength(16);
        for (let index = 0; index < 258; index++) {
            expect(page.requests[index]?.reference).toBe(`frames/${index}.jpg`);
            page.respond(page.requests[index].id);
            expect(page.requests.length - index - 1).toBeLessThanOrEqual(16);
        }
        await flushMutations();
        expect(page.requests).toHaveLength(258);
        expect(Array.from(page.document.querySelectorAll('img')).filter(image => image.getAttribute('src') === imageUrl)).toHaveLength(258);
    });

    it('releases a queued slot after failure and stops dispatching its queue after pagehide', async () => {
        const page = fixture();
        page.document.body.innerHTML = Array.from({ length: 20 }, (_, index) => `<img src="frames/${index}.jpg">`).join('');
        await flushMutations();
        expect(page.requests).toHaveLength(16);
        page.respond(page.requests[0].id, null);
        expect(page.requests).toHaveLength(17);
        expect(page.requests[16].reference).toBe('frames/16.jpg');
        expect(page.document.querySelector('img')?.getAttribute('src')).toBe('frames/0.jpg');
        page.browser.dispatchEvent(new page.browser.Event('pagehide'));
        page.respond(page.requests[1].id);
        await flushMutations();
        expect(page.requests).toHaveLength(17);
    });

    it('stops responding and observing after pagehide', async () => {
        const page = fixture('<img src="first.jpg">');
        page.browser.dispatchEvent(new page.browser.Event('pagehide'));
        page.respond(page.requests[0].id);
        page.document.body.insertAdjacentHTML('beforeend', '<img src="second.jpg">');
        await flushMutations();
        expect(page.requests).toHaveLength(1);
        expect(page.document.querySelector('img')?.getAttribute('src')).toBe('first.jpg');
    });
});
