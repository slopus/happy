import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaAttachmentPlayer } from './MediaAttachmentPlayer';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

vi.mock('react-native-webview', () => ({ WebView: 'WebView' }));

describe('MediaAttachmentPlayer native video document', () => {
    afterEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    });

    it('loads a real video element with visible native controls instead of navigating the WebView to MP4 bytes', async () => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(
                <MediaAttachmentPlayer
                    uri="file:///cache/acceptance.mp4"
                    headers={{}}
                    title="acceptance.mp4"
                    kind="video"
                    mimeType="video/mp4"
                    testID="native-video"
                />,
            );
        });

        const webView = renderer.root.findByType('WebView');
        expect(webView.props.source.uri).toBeUndefined();
        expect(webView.props.source.html).toContain('<video');
        expect(webView.props.source.html).toContain('controls');
        expect(webView.props.source.html).toContain('playsinline');
        expect(webView.props.source.html).toContain('file:///cache/acceptance.mp4');
        expect(webView.props.source.baseUrl).toBe('file:///cache/');
        expect(webView.props.allowFileAccess).toBe(true);
        expect(webView.props.allowingReadAccessToURL).toBe('file:///cache/');
        expect(webView.props.containerStyle).toMatchObject({ width: '100%', aspectRatio: 16 / 9, flex: 0 });

        await act(async () => renderer.unmount());
    });

    it('loads audio as a compact native control that requires a user action by default', async () => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(
                <MediaAttachmentPlayer
                    uri="file:///cache/voice.mp3"
                    headers={{}}
                    title="voice.mp3"
                    kind="audio"
                    mimeType="audio/mpeg"
                    testID="native-audio"
                />,
            );
        });

        const webView = renderer.root.findByType('WebView');
        expect(webView.props.source.html).toContain('<audio');
        expect(webView.props.source.html).toContain('controls');
        expect(webView.props.source.html).not.toContain(' autoplay');
        expect(webView.props.source.html).toContain('background:transparent');
        expect(webView.props.style).toMatchObject({ height: 54, backgroundColor: 'transparent' });
        expect(webView.props.containerStyle).toMatchObject({ height: 54, flex: 0 });
        expect(webView.props.mediaPlaybackRequiresUserAction).toBe(true);

        await act(async () => renderer.unmount());
    });

    it('allows click-originated audio autoplay in the native WebView', async () => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(
                <MediaAttachmentPlayer
                    uri="file:///cache/voice.mp3"
                    headers={{}}
                    title="voice.mp3"
                    kind="audio"
                    mimeType="audio/mpeg"
                    testID="native-audio"
                    autoPlay
                />,
            );
        });

        const webView = renderer.root.findByType('WebView');
        expect(webView.props.source.html).toContain('<audio controls autoplay');
        expect(webView.props.mediaPlaybackRequiresUserAction).toBe(false);

        await act(async () => renderer.unmount());
    });
});
