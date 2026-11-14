import * as React from 'react';
import { View } from 'react-native';
import { WebView } from 'react-native-webview';
import type { BotsFrameProps } from './BotsFrame.web';

export function BotsFrame({ runtimeUrl, ticket, expiresAt, onAuthenticated, onFailure }: BotsFrameProps) {
    const view = React.useRef<WebView>(null);
    const sent = React.useRef(false);
    const origin = new URL(runtimeUrl).origin;
    const send = () => {
        if (sent.current) return;
        if (Date.now() >= expiresAt) { onFailure(); return; }
        sent.current = true;
        // A string literal is generated with JSON encoding, never executable user code.
        view.current?.injectJavaScript(`window.__pawsRakazoLaunch?.(${JSON.stringify(ticket)}); true;`);
    };
    return <View style={{ flex: 1 }} testID="bots-runtime-frame">
        <WebView ref={view} source={{ uri: runtimeUrl }}
            originWhitelist={[origin]}
            javaScriptEnabled
            domStorageEnabled
            onLoadEnd={send}
            onError={onFailure}
            onHttpError={onFailure}
            onShouldStartLoadWithRequest={request => {
                try { return request.url === 'about:blank' || new URL(request.url).origin === origin; }
                catch { return false; }
            }}
            onMessage={event => {
                try {
                    if (new URL(event.nativeEvent.url).origin !== origin) return;
                    const message = JSON.parse(event.nativeEvent.data);
                    if (message.type === 'paws:rakazo:ready') send();
                    else if (message.type === 'paws:rakazo:authenticated') onAuthenticated();
                    else if (message.type === 'paws:rakazo:error') onFailure();
                } catch { /* Ignore unrelated upstream messages. */ }
            }}
        />
    </View>;
}
