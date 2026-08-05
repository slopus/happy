import * as React from 'react';
import { WebView } from 'react-native-webview';
import type { MediaAttachmentPlayerProps } from './MediaAttachmentPlayer.types';

export type { MediaAttachmentPlayerProps } from './MediaAttachmentPlayer.types';

export function MediaAttachmentPlayer(props: MediaAttachmentPlayerProps) {
    const height = props.kind === 'audio' ? 64 : 180;
    return (
        <WebView
            testID={props.testID}
            source={{ uri: props.uri, headers: props.headers }}
            style={{ width: 300, height, backgroundColor: '#000' }}
            originWhitelist={['*']}
            allowsFullscreenVideo
            allowsInlineMediaPlayback
            mediaPlaybackRequiresUserAction
            accessibilityLabel={props.title}
        />
    );
}
