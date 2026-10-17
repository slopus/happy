import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error jsdom is the test DOM, not a browser/device verification.
import { JSDOM } from 'jsdom';
import { buildNativeDocument } from './mermaidNativeDocument';
import { createMermaidThemeConfig } from './mermaidRendererModel';
import { MERMAID_RUNTIME_SOURCE } from './mermaidRuntimeSource.generated';
import { buildMermaidRuntimeSource } from '../../../scripts/generate-mermaid-runtime.cjs';

const config = createMermaidThemeConfig({ dark: false, colors: { text: '#222', textSecondary: '#555', surface: '#fff', surfaceHigh: '#eee', surfaceHighest: '#ddd', surfacePressed: '#ccc', divider: '#ccc' } });

function documentHarness(fullscreen = false) {
    const dom = new JSDOM(buildNativeDocument('flowchart TB\nA --> B', config, fullscreen), { runScripts: 'outside-only' });
    const browser = dom.window;
    const messages: Array<{ type: string }> = [];
    browser.ReactNativeWebView = { postMessage: (value: string) => messages.push(JSON.parse(value)) };
    browser.SVGElement.prototype.getBoundingClientRect = () => ({ height: 60 });
    const provideMermaid = () => {
        browser.mermaid = { initialize() {}, registerLayoutLoaders() {}, async render() {
            return { svg: '<svg viewBox="0 0 100 60"><text>正文输出</text></svg>' };
        } };
    };
    browser.eval(browser.document.querySelector('script:not([src])').textContent);
    return { browser, messages, provideMermaid, close: () => browser.close() };
}

describe('Native diagram dependency bootstrap', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('ships a current literal runtime bundle instead of runtime function serialization', () => {
        expect(MERMAID_RUNTIME_SOURCE).toBe(buildMermaidRuntimeSource());
    });

    it('waits for the Mermaid script to load before rendering', async () => {
        const page = documentHarness();
        try {
            page.provideMermaid();
            page.browser.document.querySelector('script[src]').dispatchEvent(new page.browser.Event('load'));
            await vi.waitFor(() => expect(page.browser.document.querySelector('#scene text')?.textContent).toBe('正文输出'));
            expect(page.messages).toEqual([{ type: 'previewHeight', height: 122 }]);
        } finally { page.close(); }
    });

    it('reports a stalled script once after the load deadline and ignores a late load', async () => {
        vi.useFakeTimers();
        const page = documentHarness();
        try {
            const script = page.browser.document.querySelector('script[src]');
            expect(page.messages).toEqual([]);
            await vi.advanceTimersByTimeAsync(20000);
            expect(page.messages).toEqual([{ type: 'error' }]);
            expect(page.browser.document.querySelector('#error')?.textContent).toContain('timed out');
            page.provideMermaid();
            script.dispatchEvent(new page.browser.Event('load'));
            await vi.advanceTimersByTimeAsync(20000);
            expect(page.browser.document.querySelector('#scene svg')).toBeNull();
            expect(page.messages).toEqual([{ type: 'error' }]);
        } finally { page.close(); }
    });

    it('reports a failed script without waiting for the load deadline', async () => {
        const page = documentHarness();
        try {
            page.browser.document.querySelector('script[src]').dispatchEvent(new page.browser.Event('error'));
            await vi.waitFor(() => expect(page.messages).toEqual([{ type: 'error' }]));
            expect(page.browser.document.querySelector('#error')?.textContent).toContain('load failed');
        } finally { page.close(); }
    });

    it('cancels pending loads and suppresses messages when the document is unloaded', async () => {
        vi.useFakeTimers();
        const page = documentHarness();
        try {
            const script = page.browser.document.querySelector('script[src]');
            page.browser.dispatchEvent(new page.browser.Event('pagehide'));
            page.provideMermaid();
            script.dispatchEvent(new page.browser.Event('load'));
            await vi.advanceTimersByTimeAsync(40000);
            expect(page.messages).toEqual([]);
            expect(page.browser.document.querySelector('#scene svg')).toBeNull();
        } finally { page.close(); }
    });

    it('cancels the other fullscreen dependency when either script fails', async () => {
        const page = documentHarness(true);
        try {
            page.browser.document.querySelector('script[src*="mermaid@"]').dispatchEvent(new page.browser.Event('error'));
            await vi.waitFor(() => expect(page.messages).toEqual([{ type: 'error' }]));
            expect(page.browser.document.querySelectorAll('script[src]')).toHaveLength(0);
        } finally { page.close(); }
    });
});
