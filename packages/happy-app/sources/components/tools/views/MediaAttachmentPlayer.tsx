import * as React from 'react';
import { WebView } from 'react-native-webview';
import type { MediaAttachmentPlayerProps } from './MediaAttachmentPlayer.types';

export type { MediaAttachmentPlayerProps } from './MediaAttachmentPlayer.types';

export function MediaAttachmentPlayer(props: MediaAttachmentPlayerProps) {
    const style = props.kind === 'audio'
        ? { width: 300, maxWidth: '100%' as const, height: 64, backgroundColor: '#000' }
        : {
            width: '100%' as const,
            maxWidth: 960,
            aspectRatio: 16 / 9,
            backgroundColor: '#000',
            borderRadius: 12,
            overflow: 'hidden' as const,
        };
    return (
        <WebView
            testID={props.testID}
            source={{ uri: props.uri, headers: props.headers }}
            style={style}
            originWhitelist={['*']}
            allowsFullscreenVideo
            allowsInlineMediaPlayback
            mediaPlaybackRequiresUserAction
            accessibilityLabel={props.title}
        />
    );
}
