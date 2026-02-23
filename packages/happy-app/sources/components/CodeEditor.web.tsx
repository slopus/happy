import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
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
    readOnly?: boolean;
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
    readOnly = false,
}, ref) => {
    const { rt } = useUnistyles();
    const iframeRef = React.useRef<HTMLIFrameElement>(null);
    const readyRef = React.useRef(false);
    const lastValueFromEditorRef = React.useRef(value);
    const pendingCommandsRef = React.useRef<EditorCommand[]>([]);
    const initialValueRef = React.useRef(value);
    const themeMode = rt.themeName === 'dark' ? 'dark' : 'light';
    const monacoBaseCandidates = React.useMemo(() => resolveMonacoBaseCandidates(), []);

    const html = React.useMemo(() => buildEditorHtml({
        initialValueBase64: encodeBase64Utf8(initialValueRef.current),
        initialLanguage: language,
        initialTheme: themeMode,
        initialBottomPadding: bottomPadding,
        initialReadOnly: readOnly,
        monacoBaseCandidates,
    }), []);

    const postCommand = React.useCallback((command: EditorCommand) => {
        const targetWindow = iframeRef.current?.contentWindow;
        if (!readyRef.current || !targetWindow) {
            pendingCommandsRef.current.push(command);
            return;
        }
        targetWindow.postMessage(JSON.stringify(command), '*');
    }, []);

    const flushPendingCommands = React.useCallback(() => {
        const targetWindow = iframeRef.current?.contentWindow;
        if (!readyRef.current || !targetWindow) return;
        if (pendingCommandsRef.current.length === 0) return;
        for (const command of pendingCommandsRef.current) {
            targetWindow.postMessage(JSON.stringify(command), '*');
        }
        pendingCommandsRef.current = [];
    }, []);

    React.useEffect(() => {
        function handleWindowMessage(event: MessageEvent) {
            const targetWindow = iframeRef.current?.contentWindow;
            if (!targetWindow || event.source !== targetWindow) return;
            if (typeof event.data !== 'string') return;

            try {
                const payload = JSON.parse(event.data) as EditorEvent;
                if (payload.type === 'ready') {
                    readyRef.current = true;
                    lastValueFromEditorRef.current = payload.value;
                    flushPendingCommands();
                    if (value !== payload.value) {
                        postCommand({ type: 'setValue', value });
                    }
                    return;
                }

                if (payload.type === 'change') {
                    lastValueFromEditorRef.current = payload.value;
                    onChangeText(payload.value);
                    return;
                }

                if (payload.type === 'error') {
                    console.warn('[CodeEditor.web] iframe error:', payload.message);
                }
            } catch (error) {
                console.warn('[CodeEditor.web] failed to parse iframe message:', error);
            }
        }

        window.addEventListener('message', handleWindowMessage);
        return () => {
            window.removeEventListener('message', handleWindowMessage);
        };
    }, [flushPendingCommands, onChangeText, postCommand, value]);

    React.useEffect(() => {
        if (value === lastValueFromEditorRef.current) return;
        lastValueFromEditorRef.current = value;
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

    React.useEffect(() => {
        postCommand({ type: 'setReadOnly', readOnly });
    }, [postCommand, readOnly]);

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
            {/* @ts-ignore web-only iframe */}
            <iframe
                ref={iframeRef}
                title="code-editor"
                srcDoc={html}
                sandbox="allow-scripts allow-same-origin"
                style={{
                    display: 'block',
                    width: '100%',
                    height: '100%',
                    border: 'none',
                    background: 'transparent',
                }}
            />
        </View>
    );
});

CodeEditor.displayName = 'CodeEditor';
