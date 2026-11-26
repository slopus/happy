// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({ View: 'View', ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/StyledText', () => ({ Text: 'Text' }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: {} } }) }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('./fileIO', () => ({ readWorkspaceBytes: vi.fn() }));
vi.mock('./WorkspaceButton', () => ({ WorkspaceButton: 'WorkspaceButton' }));
const bundle = vi.hoisted(() => ({ html: '<h1>preview</h1>', channel: 'test-channel', readImage: vi.fn(async () => 'data:image/png;base64,aW1hZ2U='), dispose: vi.fn() }));
vi.mock('./htmlPreviewRuntime.web', () => ({ buildHtmlFilePreview: vi.fn(async () => bundle) }));
import { HtmlFilePreview } from './HtmlFilePreview.web';

it('only serves interactive image requests from the current iframe and channel', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    bundle.readImage.mockClear();
    const frameWindow = { postMessage: vi.fn() };
    let renderer: any;
    const request = (source: unknown, channel = bundle.channel, reference = 'images/one.png', id = 1) => window.dispatchEvent(new MessageEvent('message', {
        source: source as Window, data: { type: 'paws-preview-image-request', channel, reference, id },
    }));
    await act(async () => { renderer = TestRenderer.create(<HtmlFilePreview sessionId="s" path="/work/index.html" root="/work" content="<h1>preview</h1>" />, {
        createNodeMock: (node: any) => node.type === 'iframe' ? { contentWindow: frameWindow } : null,
    }); });
    try {
        await act(async () => { request(frameWindow); });
        expect(bundle.readImage).not.toHaveBeenCalled();
        await act(async () => { renderer.root.findByType('WorkspaceButton').props.onPress(); });
        await act(async () => { request(window); request(frameWindow, 'wrong-channel'); request(frameWindow, bundle.channel, 'image.png', NaN); });
        expect(bundle.readImage).not.toHaveBeenCalled();
        await act(async () => { request(frameWindow); });
        expect(bundle.readImage).toHaveBeenCalledWith('images/one.png');
        expect(frameWindow.postMessage).toHaveBeenCalledWith({ type: 'paws-preview-image-response', channel: bundle.channel, id: 1, url: 'data:image/png;base64,aW1hZ2U=' }, '*');
    } finally { await act(async () => { renderer.unmount(); }); }
    bundle.readImage.mockClear();
    request(frameWindow);
    expect(bundle.readImage).not.toHaveBeenCalled();
});
