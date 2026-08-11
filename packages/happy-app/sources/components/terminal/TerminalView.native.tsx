import React, {
    forwardRef,
    useEffect,
    useImperativeHandle,
    useRef,
    useState,
} from 'react';
import { View } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system';

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
        cursorBlink: true,
        fontSize: 14,
        fontFamily: 'Menlo, Monaco, Consolas, monospace',
        scrollback: 5000,
        theme: { background: '#0d1117', foreground: '#e6edf3', cursor: '#e6edf3' },
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

      term.onData(function (data) { post('data', { data: data }); });
      term.onResize(function (size) { post('resize', { cols: size.cols, rows: size.rows }); });

      window.__termWrite = function (data) { term.write(data); };
      window.__termClear = function () { term.reset(); };
      window.__termFocus = function () { term.focus(); };
      window.__termFit = function () { try { fitAddon.fit(); } catch (e) {} };

      window.addEventListener('resize', function () { window.__termFit(); });
      setTimeout(function () { window.__termFit(); post('ready', {}); }, 50);
    })();
  </script>
</body>
</html>`;
}

export const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(
    function TerminalView({ onData, onResize }, ref) {
        const webviewRef = useRef<WebView | null>(null);
        const pendingWritesRef = useRef<string[]>([]);
        const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
        const [html, setHtml] = useState<string | null>(null);
        const onDataRef = useRef(onData);
        const onResizeRef = useRef(onResize);
        onDataRef.current = onData;
        onResizeRef.current = onResize;

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
                // The screen shows a connection error state; renderer stays blank.
            });
            return () => {
                cancelled = true;
            };
        }, []);

        useEffect(() => {
            flushTimerRef.current = setInterval(() => {
                if (pendingWritesRef.current.length === 0 || !webviewRef.current) {
                    return;
                }
                const data = pendingWritesRef.current.splice(0).join('');
                webviewRef.current.injectJavaScript(
                    `window.__termWrite(${JSON.stringify(data)}); true;`,
                );
            }, 50);
            return () => {
                if (flushTimerRef.current) {
                    clearInterval(flushTimerRef.current);
                    flushTimerRef.current = null;
                }
            };
        }, []);

        useImperativeHandle(ref, () => ({
            write: (data) => {
                if (html) {
                    pendingWritesRef.current.push(data);
                }
            },
            clear: () => webviewRef.current?.injectJavaScript('window.__termClear(); true;'),
            focus: () => webviewRef.current?.injectJavaScript('window.__termFocus(); true;'),
        }), [html]);

        const handleMessage = (event: WebViewMessageEvent) => {
            try {
                const message = JSON.parse(event.nativeEvent.data) as {
                    type?: string;
                    data?: string;
                    cols?: number;
                    rows?: number;
                };
                if (message.type === 'data') {
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

        const handleLayout = () => {
            setTimeout(() => {
                webviewRef.current?.injectJavaScript('window.__termFit(); true;');
            }, 50);
        };

        return (
            <View style={{ flex: 1, backgroundColor: '#0d1117' }} onLayout={handleLayout}>
                {html ? (
                    <WebView
                        ref={webviewRef}
                        source={{ html }}
                        originWhitelist={['*']}
                        javaScriptEnabled
                        domStorageEnabled
                        onMessage={handleMessage}
                        style={{ flex: 1, backgroundColor: '#0d1117' }}
                        setSupportMultipleWindows={false}
                        overScrollMode="never"
                        bounces={false}
                        keyboardDisplayRequiresUserAction={false}
                        showsVerticalScrollIndicator={false}
                        showsHorizontalScrollIndicator={false}
                    />
                ) : null}
            </View>
        );
    },
);
