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

        await act(async () => renderer.unmount());
    });
});
