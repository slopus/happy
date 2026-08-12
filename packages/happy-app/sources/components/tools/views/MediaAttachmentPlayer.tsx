import * as React from 'react';
import { WebView } from 'react-native-webview';
import type { MediaAttachmentPlayerProps } from './MediaAttachmentPlayer.types';

export type { MediaAttachmentPlayerProps } from './MediaAttachmentPlayer.types';

function escapeHtmlAttribute(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}

function mediaDocument(props: MediaAttachmentPlayerProps): string {
    const tag = props.kind === 'audio' ? 'audio' : 'video';
    const uri = escapeHtmlAttribute(props.uri);
    const mimeType = escapeHtmlAttribute(props.mimeType);
    const title = escapeHtmlAttribute(props.title);
    const poster = props.posterUri ? ` poster="${escapeHtmlAttribute(props.posterUri)}"` : '';
    return `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}
${tag}{display:block;width:100%;height:100%;object-fit:contain;background:#000}
</style>
</head>
<body>
<${tag} controls playsinline webkit-playsinline preload="metadata"${poster} aria-label="${title}">
<source src="${uri}" type="${mimeType}">
</${tag}>
</body>
</html>`;
}

function mediaBaseUrl(uri: string): string | undefined {
    if (!uri.startsWith('file:')) return undefined;
    const lastSlash = uri.lastIndexOf('/');
    return lastSlash >= 0 ? uri.slice(0, lastSlash + 1) : undefined;
}

export function MediaAttachmentPlayer(props: MediaAttachmentPlayerProps) {
    const style = props.kind === 'audio'
        ? { width: 300, maxWidth: '100%' as const, height: 64, backgroundColor: '#000' }
        : {
            width: '100%' as const,
            maxWidth: 960,
            aspectRatio: props.aspectRatio ?? 16 / 9,
            backgroundColor: '#000',
            borderRadius: 12,
            overflow: 'hidden' as const,
        };
    const baseUrl = mediaBaseUrl(props.uri);
    return (
        <WebView
            testID={props.testID}
            source={{ html: mediaDocument(props), ...(baseUrl ? { baseUrl } : {}) }}
            style={style}
            originWhitelist={['*']}
            allowFileAccess
            allowingReadAccessToURL={baseUrl}
            allowsFullscreenVideo
            allowsInlineMediaPlayback
            mediaPlaybackRequiresUserAction
            androidLayerType="hardware"
            accessibilityLabel={props.title}
        />
    );
}
