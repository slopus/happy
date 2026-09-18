import * as React from 'react';
import { WebView } from 'react-native-webview';
import { AGENT_PARTY_URL, type PartySurfaceProps } from './bridge';
export function PartySurface({ url, onMessage, onError }: PartySurfaceProps) {
    return <WebView source={{ uri: url }} style={{ flex: 1 }}
        originWhitelist={['https://47.115.228.20:8443']}
        onShouldStartLoadWithRequest={request => request.url.startsWith(AGENT_PARTY_URL)}
        onMessage={event => {
            if (!event.nativeEvent.url.startsWith(AGENT_PARTY_URL)) return;
            try { onMessage(JSON.parse(event.nativeEvent.data)); } catch { /* Ignore malformed bridge messages. */ }
        }}
        onError={onError} onHttpError={onError}
        javaScriptCanOpenWindowsAutomatically={false} setSupportMultipleWindows={false}
        allowFileAccess={false} allowUniversalAccessFromFileURLs={false} mixedContentMode="never"
        automaticallyAdjustContentInsets={false} />;
}
