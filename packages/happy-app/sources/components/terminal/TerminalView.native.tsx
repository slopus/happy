import React, {
    forwardRef,
    useEffect,
    useImperativeHandle,
    useRef,
    useState,
} from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system';
import {
    TerminalOperationQueue,
    type TerminalOperation,
} from './terminalOperationQueue';

const xtermJsAsset = require('../../../assets/terminal/xterm.js.txt');
const addonFitJsAsset = require('../../../assets/terminal/addon-fit.js.txt');
const xtermCssAsset = require('../../../assets/terminal/xterm.css.txt');

export interface TerminalViewHandle {
    write(data: string): void;
    clear(): void;
    focus(): void;
}

export interface TerminalViewProps {
    onData: (data: string) => void;
    onResize: (cols: number, rows: number) => void;
    fontSize?: number;
    dark?: boolean;
    readOnly?: boolean;
}

async function loadAssetText(assetId: number): Promise<string> {
    const asset = Asset.fromModule(assetId);
    await asset.downloadAsync();
    const uri = asset.localUri ?? asset.uri;
    return FileSystem.readAsStringAsync(uri);
}

function buildHtml(xtermJs: string, addonFitJs: string, xtermCss: string): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
  <style>${xtermCss}
    html, body, #term { width: 100%; height: 100%; margin: 0; padding: 0; overflow: hidden; background: #0d1117; }
  </style>
</head>
<body>
  <div id="term"></div>
  <script>${addonFitJs}</script>
  <script>${xtermJs}</script>
  <script>
    (function () {
      var term = new Terminal({
        cursorBlink: false,
        fontSize: 14,
        fontFamily: 'Menlo, Monaco, Consolas, monospace',
        scrollback: 5000,
        theme: { background: '#0d1117', foreground: '#e6edf3', cursor: '#e6edf3' },
        disableStdin: true,
        allowProposedApi: true
      });
      var fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(document.getElementById('term'));

      function post(type, payload) {
        if (window.ReactNativeWebView) {
          window.ReactNativeWebView.postMessage(JSON.stringify(Object.assign({ type: type }, payload)));
        }
      }

      term.onData(function (data) {
        if (!term.options.disableStdin) {
          post('data', { data: data });
        }
      });
      term.onResize(function (size) { post('resize', { cols: size.cols, rows: size.rows }); });

      window.__termWrite = function (data) { term.write(data); };
      window.__termClear = function () { term.reset(); };
      window.__termFocus = function () { term.focus(); };
      window.__termFit = function () { try { fitAddon.fit(); } catch (e) {} };
      window.__termSetReadOnly = function (readOnly) {
        var nextReadOnly = Boolean(readOnly);
        term.options.disableStdin = nextReadOnly;
        term.options.cursorBlink = !nextReadOnly;
        if (nextReadOnly) term.blur();
      };

      window.addEventListener('resize', function () { window.__termFit(); });
      setTimeout(function () { window.__termFit(); post('ready', {}); }, 50);
    })();
  </script>
</body>
</html>`;
}

export const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(
    function TerminalView({ onData, onResize, readOnly = false }, ref) {
        const webviewRef = useRef<WebView | null>(null);
        const [html, setHtml] = useState<string | null>(null);
        const [ready, setReady] = useState(false);
        const [rendererError, setRendererError] = useState<string | null>(null);
        const onDataRef = useRef(onData);
        const onResizeRef = useRef(onResize);
        const readOnlyRef = useRef(readOnly);
        const operationQueueRef = useRef<TerminalOperationQueue | null>(null);
        onDataRef.current = onData;
        onResizeRef.current = onResize;
        readOnlyRef.current = readOnly;

        if (!operationQueueRef.current) {
            operationQueueRef.current = new TerminalOperationQueue((operation: TerminalOperation) => {
                const webview = webviewRef.current;
                if (!webview) {
                    return;
                }

                switch (operation.type) {
                    case 'reset':
                        webview.injectJavaScript('window.__termClear(); true;');
                        break;
                    case 'write':
                        webview.injectJavaScript(
                            `window.__termWrite(${JSON.stringify(operation.data)}); true;`,
                        );
                        break;
                    case 'focus':
                        webview.injectJavaScript('window.__termFocus(); true;');
                        break;
                    case 'fit':
                        webview.injectJavaScript('window.__termFit(); true;');
                        break;
                    case 'setReadOnly':
                        webview.injectJavaScript(
                            `window.__termSetReadOnly(${JSON.stringify(operation.readOnly)}); true;`,
                        );
                        break;
                }
            });
        }
        const operationQueue = operationQueueRef.current;

        useEffect(() => {
            let cancelled = false;
            void Promise.all([
                loadAssetText(xtermJsAsset),
                loadAssetText(addonFitJsAsset),
                loadAssetText(xtermCssAsset),
            ]).then(([xtermJs, addonFitJs, xtermCss]) => {
                if (!cancelled) {
                    setHtml(buildHtml(xtermJs, addonFitJs, xtermCss));
                }
            }).catch(() => {
                if (!cancelled) {
                    setRendererError('Unable to prepare terminal renderer.');
                }
            });
            return () => {
                cancelled = true;
            };
        }, []);

        useEffect(() => {
            operationQueue.enqueue({ type: 'setReadOnly', readOnly });
        }, [operationQueue, readOnly]);

        useImperativeHandle(ref, () => ({
            write: (data) => operationQueue.enqueue({ type: 'write', data }),
            clear: () => operationQueue.enqueue({ type: 'reset' }),
            focus: () => operationQueue.enqueue({ type: 'focus' }),
        }), [operationQueue]);

        const handleMessage = (event: WebViewMessageEvent) => {
            try {
                const message = JSON.parse(event.nativeEvent.data) as {
                    type?: string;
                    data?: string;
                    cols?: number;
                    rows?: number;
                };
                if (message.type === 'ready') {
                    operationQueue.markReady();
                    setReady(true);
                } else if (message.type === 'data' && !readOnlyRef.current) {
                    onDataRef.current(String(message.data ?? ''));
                } else if (message.type === 'resize') {
                    onResizeRef.current(
                        Number(message.cols) || 80,
                        Number(message.rows) || 24,
                    );
                }
            } catch {
                // Ignore malformed bridge messages.
            }
        };

        const handleLoadStart = () => {
            setReady(false);
            setRendererError(null);
            operationQueue.markNotReady();
        };

        const handleLayout = () => {
            operationQueue.enqueue({ type: 'fit' });
        };

        return (
            <View style={styles.container} onLayout={handleLayout}>
                {html ? (
                    <WebView
                        ref={webviewRef}
                        source={{ html }}
                        originWhitelist={['*']}
                        javaScriptEnabled
                        domStorageEnabled
                        onMessage={handleMessage}
                        onLoadStart={handleLoadStart}
                        onError={() => setRendererError('Unable to load terminal renderer.')}
                        style={styles.webview}
                        setSupportMultipleWindows={false}
                        overScrollMode="never"
                        bounces={false}
                        keyboardDisplayRequiresUserAction={false}
                        showsVerticalScrollIndicator={false}
                        showsHorizontalScrollIndicator={false}
                    />
                ) : null}
                {!ready && (
                    <View pointerEvents="none" style={styles.loadingOverlay}>
                        {!rendererError && <ActivityIndicator size="small" color="#8b949e" />}
                        <Text style={styles.loadingText}>
                            {rendererError || 'Preparing terminal…'}
                        </Text>
                    </View>
                )}
            </View>
        );
    },
);

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#0d1117',
    },
    webview: {
        flex: 1,
        backgroundColor: '#0d1117',
    },
    loadingOverlay: {
        ...StyleSheet.absoluteFillObject,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#0d1117',
        gap: 10,
    },
    loadingText: {
        color: '#8b949e',
        fontSize: 13,
    },
});
