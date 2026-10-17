import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer is only used by this component harness.
import TestRenderer from 'react-test-renderer';
// @ts-expect-error jsdom provides the test runtime without optional declaration files.
import { JSDOM } from 'jsdom';

vi.mock('react-native', () => ({
    Modal: 'Modal',
    Platform: { OS: 'android' },
    Pressable: 'Pressable',
    Text: 'Text',
    View: 'View',
    useWindowDimensions: () => ({ width: 390, height: 720 }),
}));
vi.mock('react-native-webview', () => ({ WebView: 'WebView' }));
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather' }));
vi.mock('react-native-unistyles', () => {
    const theme = {
        dark: true,
        colors: {
            divider: '#39424c',
            surface: '#12171c',
            surfaceHigh: '#1b2229',
            surfaceHighest: '#242c34',
            surfacePressed: '#303a45',
            text: '#f4f7fa',
            textSecondary: '#aeb8c2',
            modal: { backdrop: 'rgba(0,0,0,0.62)' },
        },
    };
    const runtime = { insets: { bottom: 12, left: 0, right: 0, top: 24 }, screen: { height: 720 } };
    return {
        StyleSheet: {
            absoluteFillObject: { bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
            create: (factory: any) => factory(theme, runtime),
            hairlineWidth: 1,
        },
        useUnistyles: () => ({ theme }),
    };
});
vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({ fontFamily: 'Default-Regular' }),
        mono: (weight = 'regular') => ({
            fontFamily: weight === 'semiBold'
                ? 'MapleMonoNL-SemiBold'
                : weight === 'italic'
                    ? 'MapleMonoNL-Italic'
                    : 'MapleMonoNL-Regular',
        }),
    },
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/utils/imageDownload', () => ({ downloadImage: vi.fn().mockResolvedValue('paws-diagram.svg') }));

import { MermaidRenderer } from './MermaidRenderer';
import { downloadImage } from '@/utils/imageDownload';
import { createMermaidRuntime } from './mermaidRuntime';

describe('MermaidRenderer native interaction contract', () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined;

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(() => {
        act(() => renderer?.unmount());
        renderer = undefined;
        vi.restoreAllMocks();
    });

    it('renders when the native engine cannot recover function source from bytecode', async () => {
        // Hermes does not retain ordinary function source. The WebView must not
        // depend on Function.toString to transport the runtime into its realm.
        vi.spyOn(createMermaidRuntime as unknown as { toString: () => string }, 'toString').mockReturnValue('function createMermaidRuntime(a0, a1) { [bytecode] }');
        await act(async () => { renderer = TestRenderer.create(<MermaidRenderer content="flowchart TB\nA --> B" />); });
        const dom = new JSDOM(renderer!.root.findByType('WebView').props.source.html, { runScripts: 'outside-only' });
        const browser = dom.window;
        browser.mermaid = { initialize() {}, registerLayoutLoaders() {}, async render() {
            return { svg: '<svg viewBox="0 0 100 60"><text>正文输出</text></svg>' };
        } };
        try {
            browser.eval(browser.document.querySelector('script:not([src])').textContent);
            await vi.waitFor(() => expect(browser.document.querySelector('#scene text')?.textContent).toBe('正文输出'));
        } finally { browser.close(); }
    });

    it('adapts explicit light node fills in the actual WebView bootstrap without changing source text', async () => {
        const content = 'flowchart TB\nA[正文输出]\nstyle A fill:#e8f5e9';
        await act(async () => { renderer = TestRenderer.create(<MermaidRenderer content={content} />); });
        const dom = new JSDOM(renderer!.root.findByType('WebView').props.source.html, { runScripts: 'outside-only' });
        const browser = dom.window;
        let renderedSource = '';
        browser.CSS = { supports: () => true };
        browser.mermaid = { initialize() {}, registerLayoutLoaders() {}, async render(_id: string, source: string) {
            renderedSource = source;
            return { svg: '<svg viewBox="0 0 100 60"><g class="node"><rect class="label-container" style="fill:#e8f5e9"/><text>正文输出</text></g></svg>' };
        } };
        try {
            browser.eval(browser.document.querySelector('script:not([src])').textContent);
            await vi.waitFor(() => expect(browser.document.querySelector('#scene rect')).not.toBeNull());
            const fill = browser.document.querySelector('#scene rect').style.fill;
            expect(fill).toContain('color-mix');
            expect(fill).toContain('#12171c');
            expect(browser.document.querySelector('#scene text').style.fill).toBe('#f4f7fa');
            expect(renderedSource).toBe(content);
        } finally { browser.close(); }
    });

    it('leaves inline gestures to the chat and enables interaction only in fullscreen', async () => {
        await act(async () => {
            renderer = TestRenderer.create(<MermaidRenderer content="flowchart LR\nA --> B" />);
        });

        expect(renderer!.root.findByType('WebView').props).toMatchObject({
            nestedScrollEnabled: true,
            overScrollMode: 'never',
            scrollEnabled: false,
        });
        const inlineWebView = renderer!.root.findByType('WebView');
        expect(inlineWebView.parent.props.pointerEvents).toBe('none');
        expect(inlineWebView.props.source.html).not.toContain('<script src="https://cdn.jsdelivr.net/npm/@panzoom');
        expect(inlineWebView.props.source.html).toContain("svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')");

        act(() => renderer!.root.findByProps({ testID: 'mermaid-fullscreen-open' }).props.onPress());
        const fullscreenWebView = renderer!.root.findAllByType('WebView')[1];
        expect(fullscreenWebView.props.scrollEnabled).toBe(true);
        expect(fullscreenWebView.parent.props.pointerEvents).toBe('auto');
        expect(fullscreenWebView.props.source.html).toContain('body { padding: 0px');
    });

    it('keeps a top-aligned width-based native preview and sizes short diagrams to their content', async () => {
        await act(async () => {
            renderer = TestRenderer.create(<MermaidRenderer content="flowchart TD\nA --> B" />);
        });
        const webView = renderer!.root.findByType('WebView');
        const dom = new JSDOM(webView.props.source.html, { runScripts: 'outside-only' });
        const browser = dom.window;
        const messages: Array<{ type: string; height?: number }> = [];
        browser.ReactNativeWebView = { postMessage: (value: string) => messages.push(JSON.parse(value)) };
        browser.mermaid = { initialize() {}, registerLayoutLoaders() {}, async render() {
            return { svg: '<svg viewBox="0 0 400 2000" style="max-width:400px"><g /></svg>' };
        } };
        browser.SVGElement.prototype.getBoundingClientRect = () => ({ height: 1600 });
        try {
            browser.eval(browser.document.querySelector('script:not([src])').textContent);
            await vi.waitFor(() => expect(messages).toContainEqual({ type: 'previewHeight', height: 1662 }));
            expect(browser.getComputedStyle(browser.document.body).paddingTop).toBe('46px');
            const svg = browser.document.querySelector('svg');
            expect(browser.getComputedStyle(svg).height).toBe('auto');
            expect(browser.getComputedStyle(svg).maxHeight).toBe('none');
            expect(browser.getComputedStyle(svg).maxWidth).toBe('none');
            expect(browser.getComputedStyle(browser.document.querySelector('#viewport')).alignItems).toBe('flex-start');
            expect(Object.assign({}, ...webView.parent.props.style)).toMatchObject({ height: 504, maxHeight: 504, overflow: 'hidden' });
            act(() => webView.props.onMessage({ nativeEvent: { data: JSON.stringify({ type: 'previewHeight', height: 180 }) } }));
            expect(Object.assign({}, ...webView.parent.props.style).height).toBe(180);
            act(() => webView.props.onMessage({ nativeEvent: { data: JSON.stringify({ type: 'previewHeight', height: -1 }) } }));
            expect(Object.assign({}, ...webView.parent.props.style).height).toBe(180);
        } finally { browser.close(); }
    });

    it('keeps lightbox controls within safe areas and reflects the WebView scale and download', async () => {
        await act(async () => {
            renderer = TestRenderer.create(<MermaidRenderer content="flowchart LR\nA --> B" />);
        });

        act(() => renderer!.root.findByProps({ testID: 'mermaid-fullscreen-open' }).props.onPress());

        const modal = renderer!.root.findByType('Modal');
        const surface = renderer!.root.findByProps({ testID: 'mermaid-fullscreen-surface' });
        expect(modal.props).toMatchObject({
            navigationBarTranslucent: true,
            statusBarTranslucent: true,
        });
        expect(surface.props.style).toContainEqual({
            borderRadius: 20,
            borderWidth: 0,
            flex: 1,
            width: '100%',
        });
        expect(renderer!.root.findByProps({ testID: 'mermaid-fullscreen-layout' }).props.style).toMatchObject({
            paddingBottom: 92,
            paddingTop: 88,
        });
        const webView = renderer!.root.findAllByType('WebView')[1];
        act(() => webView.props.onMessage({ nativeEvent: { data: JSON.stringify({ type: 'scale', scale: 0.57 }) } }));
        expect(renderer!.root.findByProps({ testID: 'mermaid-zoom-percent' }).props.children).toBe('57%');
        await act(async () => webView.props.onMessage({ nativeEvent: { data: JSON.stringify({ type: 'download', uri: 'data:image/svg+xml;base64,PHN2Zy8+' }) } }));
        expect(downloadImage).toHaveBeenCalledWith({ filename: 'paws-diagram.svg', uri: 'data:image/svg+xml;base64,PHN2Zy8+' });
    });

    it('uses the chat Maple faces in the diagram error fallback', async () => {
        await act(async () => {
            renderer = TestRenderer.create(<MermaidRenderer content="not mermaid" typography="chatMono" />);
        });

        act(() => renderer!.root.findByType('WebView').props.onMessage({
            nativeEvent: { data: JSON.stringify({ type: 'error' }) },
        }));

        const textNodes = renderer!.root.findAllByType('Text');
        const title = textNodes.find((node: any) => node.props.children === 'markdown.mermaidRenderFailed')!;
        const code = textNodes.find((node: any) => node.props.children === 'not mermaid')!;
        expect(Object.assign({}, ...title.props.style.filter(Boolean))).toMatchObject({
            fontFamily: 'MapleMonoNL-SemiBold',
            fontWeight: 'normal',
        });
        expect(Object.assign({}, ...code.props.style.filter(Boolean)).fontFamily).toBe('MapleMonoNL-Regular');
    });

    it.each(['onError', 'onHttpError', 'onRenderProcessGone'])('shows the existing error fallback after a WebView %s', async (callback) => {
        await act(async () => { renderer = TestRenderer.create(<MermaidRenderer content="flowchart TB\nA --> B" />); });
        act(() => renderer!.root.findByType('WebView').props[callback]({ nativeEvent: {} }));
        expect(renderer!.root.findAllByType('Text').some((node: any) => node.props.children === 'markdown.mermaidRenderFailed')).toBe(true);
    });

    it('allows updated source to render after a native load failure', async () => {
        await act(async () => { renderer = TestRenderer.create(<MermaidRenderer content="flowchart TB\nA --> B" />); });
        act(() => renderer!.root.findByType('WebView').props.onError({ nativeEvent: {} }));
        await act(async () => { renderer!.update(<MermaidRenderer content="flowchart TB\nB --> C" />); });
        expect(renderer!.root.findAllByType('Text').some((node: any) => node.props.children === 'markdown.mermaidRenderFailed')).toBe(false);
        expect(renderer!.root.findAllByType('WebView')).toHaveLength(1);
    });

    it('runs the WebView bootstrap with an HTML panzoom target and exports complete valid SVG', async () => {
        await act(async () => {
            renderer = TestRenderer.create(<MermaidRenderer content="flowchart TD\nA --> B" />);
        });
        act(() => renderer!.root.findByProps({ testID: 'mermaid-fullscreen-open' }).props.onPress());
        const html = renderer!.root.findAllByType('WebView')[1].props.source.html;
        const dom = new JSDOM(html, { runScripts: 'outside-only' });
        const browser = dom.window;
        const calls: Array<{ tag: string; origin?: string }> = [];
        const messages: Array<{ type: string; uri?: string }> = [];
        browser.TextEncoder = TextEncoder;
        browser.ReactNativeWebView = { postMessage: (value: string) => messages.push(JSON.parse(value)) };
        browser.mermaid = { initialize() {}, registerLayoutLoaders() {}, async render() {
            return { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 2000"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><p>澄清目标<br>交付成果</p></div></foreignObject></svg>' };
        } };
        browser.Panzoom = (target: HTMLElement, options: { origin?: string }) => {
            calls.push({ tag: target.tagName, origin: options.origin });
            target.style.transform = 'scale(2) translate(30px, 40px)';
            return { reset() {}, zoomIn() {}, zoomOut() {}, zoomWithWheel() {}, setOptions() {} };
        };
        try {
            browser.eval(browser.document.querySelector('script:not([src])').textContent);
            await vi.waitFor(() => expect(browser.__pawsMermaid).toBeDefined());
            expect(calls).toEqual([{ tag: 'DIV', origin: undefined }]);
            browser.__pawsMermaid.download();
            const exported = messages.find(message => message.type === 'download')!.uri!;
            const svgText = Buffer.from(exported.split(',')[1], 'base64').toString('utf8');
            const document = new browser.DOMParser().parseFromString(svgText, 'image/svg+xml');
            expect(document.querySelector('parsererror')).toBeNull();
            expect(document.documentElement.getAttribute('width')).toBe('400');
            expect(document.documentElement.getAttribute('height')).toBe('2000');
            expect(document.documentElement.style.transform).toBe('');
            expect(document.querySelector('p').textContent).toBe('澄清目标交付成果');
        } finally { browser.close(); }
    });
});
