import * as React from 'react';
import { WebView } from 'react-native-webview';
import { goalHtmlHostDocument } from '@/utils/goalHtmlDocument';

export const GoalHtmlPreview = React.memo(function GoalHtmlPreview({ content, title }: { content: string; title: string }) {
    const html = React.useMemo(() => goalHtmlHostDocument(content, title), [content, title]);
    return <WebView accessibilityLabel={title} source={{ html, baseUrl: 'about:blank' }}
        style={{ flex: 1 }} originWhitelist={['*']} javaScriptEnabled
        allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
        setSupportMultipleWindows={false} onShouldStartLoadWithRequest={request => request.url === 'about:blank' || request.url.startsWith('blob:')} />;
});
