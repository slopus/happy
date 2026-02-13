import * as React from 'react';
import { Platform, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import {
    buildEditorHtml,
    encodeBase64Utf8,
    resolveMonacoBaseCandidates,
    type EditorCommand,
    type EditorEvent,
} from '@/components/codeEditorMonacoShared';

interface CodeEditorProps {
    value: string;
    onChangeText: (text: string) => void;
    bottomPadding?: number;
    language?: string;
}

export interface CodeEditorHandle {
    focus: () => void;
    blur: () => void;
}

export const CodeEditor = React.forwardRef<CodeEditorHandle, CodeEditorProps>(({
    value,
    onChangeText,
    bottomPadding = 16,
    language = 'plaintext',
}, ref) => {
    const { rt } = useUnistyles();
    const webViewRef = React.useRef<WebView>(null);
    const readyRef = React.useRef(false);
    const lastValueFromWebRef = React.useRef(value);
    const pendingCommandsRef = React.useRef<EditorCommand[]>([]);
    const initialValueRef = React.useRef(value);
    const themeMode = rt.themeName === 'dark' ? 'dark' : 'light';
    const monacoBaseCandidates = React.useMemo(() => resolveMonacoBaseCandidates(), []);

    const html = React.useMemo(() => buildEditorHtml({
        initialValueBase64: encodeBase64Utf8(initialValueRef.current),
        initialLanguage: language,
        initialTheme: themeMode,
        initialBottomPadding: bottomPadding,
        monacoBaseCandidates,
    }), []);

    const postCommand = React.useCallback((command: EditorCommand) => {
        if (!readyRef.current || !webViewRef.current) {
            pendingCommandsRef.current.push(command);
            return;
        }
        webViewRef.current.postMessage(JSON.stringify(command));
    }, []);

    const flushPendingCommands = React.useCallback(() => {
        if (!readyRef.current || !webViewRef.current) return;
        if (pendingCommandsRef.current.length === 0) return;
        for (const command of pendingCommandsRef.current) {
            webViewRef.current.postMessage(JSON.stringify(command));
        }
        pendingCommandsRef.current = [];
    }, []);

    const handleMessage = React.useCallback((event: WebViewMessageEvent) => {
        try {
            const payload = JSON.parse(event.nativeEvent.data) as EditorEvent;
            if (payload.type === 'ready') {
                readyRef.current = true;
                lastValueFromWebRef.current = payload.value;
                flushPendingCommands();
                if (value !== payload.value) {
                    postCommand({ type: 'setValue', value });
                }
                return;
            }

            if (payload.type === 'change') {
                lastValueFromWebRef.current = payload.value;
                onChangeText(payload.value);
                return;
            }

            if (payload.type === 'error') {
                console.warn('[CodeEditor] webview error:', payload.message);
            }
        } catch (error) {
            console.warn('[CodeEditor] failed to parse webview message:', error);
        }
    }, [flushPendingCommands, onChangeText, postCommand, value]);

    React.useEffect(() => {
        if (value === lastValueFromWebRef.current) return;
        lastValueFromWebRef.current = value;
        postCommand({ type: 'setValue', value });
    }, [postCommand, value]);

    React.useEffect(() => {
        postCommand({ type: 'setLanguage', language });
    }, [language, postCommand]);

    React.useEffect(() => {
        postCommand({ type: 'setTheme', theme: themeMode });
    }, [postCommand, themeMode]);

    React.useEffect(() => {
        postCommand({ type: 'setBottomPadding', bottomPadding });
    }, [bottomPadding, postCommand]);

    React.useImperativeHandle(ref, () => ({
        focus: () => {
            postCommand({ type: 'focus' });
        },
        blur: () => {
            postCommand({ type: 'blur' });
        },
    }), [postCommand]);

    return (
        <View style={{ flex: 1 }}>
            <WebView
                ref={webViewRef}
                originWhitelist={['*']}
                source={{ html }}
                onMessage={handleMessage}
                javaScriptEnabled
                domStorageEnabled
                setSupportMultipleWindows={false}
                mixedContentMode="always"
                keyboardDisplayRequiresUserAction={false}
                hideKeyboardAccessoryView={Platform.OS === 'ios'}
                style={{ flex: 1, backgroundColor: 'transparent' }}
            />
        </View>
    );
});

CodeEditor.displayName = 'CodeEditor';
