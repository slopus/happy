export type EditorCommand =
    | { type: 'setValue'; value: string }
    | { type: 'setLanguage'; language: string }
    | { type: 'setTheme'; theme: 'light' | 'dark' }
    | { type: 'setBottomPadding'; bottomPadding: number }
    | { type: 'focus' }
    | { type: 'blur' };

export type EditorEvent =
    | { type: 'ready'; value: string }
    | { type: 'change'; value: string }
    | { type: 'error'; message: string };

const MONACO_CDN_BASE = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min';
const MONACO_WEB_LOCAL_BASE = '/vendor/monaco';

function normalizeMonacoBase(base: string): string {
    return base.trim().replace(/\/+$/, '');
}

function uniqueMonacoBases(values: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
        const normalized = normalizeMonacoBase(value);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        result.push(normalized);
    }
    return result;
}

export function resolveMonacoBaseCandidates(): string[] {
    const candidates: string[] = [];
    const envBase = process.env.EXPO_PUBLIC_MONACO_BASE_URL;
    if (typeof envBase === 'string' && envBase.trim().length > 0) {
        candidates.push(envBase);
    }

    const runtimeBase = (globalThis as { __HAPPY_MONACO_BASE_URL?: unknown }).__HAPPY_MONACO_BASE_URL;
    if (typeof runtimeBase === 'string' && runtimeBase.trim().length > 0) {
        candidates.push(runtimeBase);
    }

    const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
    if (isBrowser) {
        candidates.push(MONACO_WEB_LOCAL_BASE);
    }

    candidates.push(MONACO_CDN_BASE);
    return uniqueMonacoBases(candidates);
}

export function encodeBase64Utf8(value: string): string {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

export function buildEditorHtml(args: {
    initialValueBase64: string;
    initialLanguage: string;
    initialTheme: 'light' | 'dark';
    initialBottomPadding: number;
    monacoBaseCandidates: string[];
}) {
    const {
        initialValueBase64,
        initialLanguage,
        initialTheme,
        initialBottomPadding,
        monacoBaseCandidates,
    } = args;
    const safeLanguage = JSON.stringify(initialLanguage);
    const safeTheme = JSON.stringify(initialTheme);
    const safeBottomPadding = Number.isFinite(initialBottomPadding) ? initialBottomPadding : 16;
    const safeMonacoBaseCandidates = JSON.stringify(monacoBaseCandidates);

    return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
    <style>
      html, body, #root {
        margin: 0;
        padding: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: transparent;
      }
      #root {
        position: relative;
      }
      #fallback {
        display: none;
        box-sizing: border-box;
        width: 100%;
        height: 100%;
        border: 0;
        outline: none;
        resize: none;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        font-size: 14px;
        line-height: 20px;
        padding: 12px 12px ${safeBottomPadding}px;
        white-space: pre;
        overflow: auto;
      }
      .monaco-editor .iPadShowKeyboard {
        width: 26px !important;
        height: 18px !important;
        margin-top: -8px !important;
        background-size: contain !important;
      }
      .monaco-editor .iPadShowKeyboard .monaco-custom-toggle {
        width: 28px !important;
        height: 28px !important;
      }
      .monaco-editor .iPadShowKeyboard .codicon {
        font-size: 13px !important;
      }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <textarea id="fallback" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off" wrap="off"></textarea>
    <script>
      (function () {
        var initialValueBase64 = ${JSON.stringify(initialValueBase64)};
        var initialLanguage = ${safeLanguage};
        var initialTheme = ${safeTheme};
        var initialBottomPadding = ${safeBottomPadding};
        var monacoBaseCandidates = ${safeMonacoBaseCandidates};

        var editor = null;
        var fallback = document.getElementById('fallback');
        var root = document.getElementById('root');
        var suppressChanges = false;

        function decodeBase64Utf8(str) {
          var binary = atob(str);
          var bytes = new Uint8Array(binary.length);
          for (var i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
          }
          return new TextDecoder('utf-8').decode(bytes);
        }

        function post(event) {
          var data = JSON.stringify(event);
          if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
            window.ReactNativeWebView.postMessage(data);
            return;
          }
          if (window.parent && window.parent !== window && typeof window.parent.postMessage === 'function') {
            window.parent.postMessage(data, '*');
          }
        }

        function setFallbackTheme(theme) {
          var dark = theme === 'dark';
          fallback.style.background = dark ? '#14161a' : '#ffffff';
          fallback.style.color = dark ? '#d4d4d4' : '#1f2328';
          fallback.style.caretColor = dark ? '#d4d4d4' : '#1f2328';
        }

        function mountFallback(initialValue) {
          root.style.display = 'none';
          fallback.style.display = 'block';
          fallback.value = initialValue;
          setFallbackTheme(initialTheme);
          fallback.addEventListener('input', function () {
            post({ type: 'change', value: fallback.value });
          });
          post({ type: 'ready', value: fallback.value });
        }

        function applyCommand(command) {
          if (command.type === 'setTheme') {
            initialTheme = command.theme;
            if (editor && window.monaco) {
              window.monaco.editor.setTheme(command.theme === 'dark' ? 'happy-dark' : 'happy-light');
            } else {
              setFallbackTheme(command.theme);
            }
            return;
          }

          if (command.type === 'setBottomPadding') {
            var padding = Math.max(0, command.bottomPadding || 0);
            if (editor) {
              editor.updateOptions({ padding: { top: 12, bottom: padding } });
            } else {
              fallback.style.paddingBottom = padding + 'px';
            }
            return;
          }

          if (command.type === 'setValue') {
            if (editor) {
              var current = editor.getValue();
              if (current !== command.value) {
                suppressChanges = true;
                editor.setValue(command.value);
                suppressChanges = false;
              }
            } else if (fallback.value !== command.value) {
              fallback.value = command.value;
            }
            return;
          }

          if (command.type === 'setLanguage') {
            if (editor && window.monaco) {
              var model = editor.getModel();
              if (model) {
                window.monaco.editor.setModelLanguage(model, command.language || 'plaintext');
              }
            }
            return;
          }

          if (command.type === 'focus') {
            if (editor) editor.focus();
            else fallback.focus();
            return;
          }

          if (command.type === 'blur') {
            if (editor && document.activeElement instanceof HTMLElement) {
              document.activeElement.blur();
            } else {
              fallback.blur();
            }
          }
        }

        function attachCommandBridge() {
          function handleMessage(event) {
            if (!event || typeof event.data !== 'string') return;
            try {
              var command = JSON.parse(event.data);
              applyCommand(command);
            } catch (error) {
              post({ type: 'error', message: String(error) });
            }
          }
          window.addEventListener('message', handleMessage);
          document.addEventListener('message', handleMessage);
        }

        function loadScript(url, onLoad, onError) {
          var script = document.createElement('script');
          script.src = url;
          script.async = true;
          script.onload = onLoad;
          script.onerror = onError;
          document.head.appendChild(script);
        }

        function tryMountMonaco(initialValue, candidateIndex) {
          if (!Array.isArray(monacoBaseCandidates) || candidateIndex >= monacoBaseCandidates.length) {
            post({ type: 'error', message: 'Monaco unavailable, fallback to plain editor' });
            mountFallback(initialValue);
            return;
          }

          var base = String(monacoBaseCandidates[candidateIndex] || '').replace(/\\/+$/, '');
          if (!base) {
            tryMountMonaco(initialValue, candidateIndex + 1);
            return;
          }

          function loadFromBase() {
            if (!window.require || !window.require.config) {
              tryMountMonaco(initialValue, candidateIndex + 1);
              return;
            }

            window.require.config({ paths: { vs: base + '/vs' } });
            window.require(['vs/editor/editor.main'], function () {
              if (window.monaco && window.monaco.languages && window.monaco.languages.typescript) {
                var disabledDiagnostics = {
                  noSemanticValidation: true,
                  noSyntaxValidation: true,
                  noSuggestionDiagnostics: true,
                };
                window.monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions(disabledDiagnostics);
                window.monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions(disabledDiagnostics);
              }

              window.monaco.editor.defineTheme('happy-dark', {
                base: 'vs-dark',
                inherit: true,
                rules: [],
                colors: {
                  'editor.background': '#14161a',
                  'editorLineNumber.foreground': '#6b7280',
                  'editorLineNumber.activeForeground': '#9ca3af',
                },
              });
              window.monaco.editor.defineTheme('happy-light', {
                base: 'vs',
                inherit: true,
                rules: [],
                colors: {
                  'editor.background': '#ffffff',
                  'editorLineNumber.foreground': '#9ca3af',
                  'editorLineNumber.activeForeground': '#4b5563',
                },
              });

              editor = window.monaco.editor.create(root, {
                value: initialValue,
                language: initialLanguage || 'plaintext',
                theme: initialTheme === 'dark' ? 'happy-dark' : 'happy-light',
                automaticLayout: true,
                minimap: { enabled: false },
                lineNumbers: 'on',
                lineNumbersMinChars: 3,
                glyphMargin: false,
                folding: false,
                fontSize: 14,
                lineHeight: 20,
                tabSize: 2,
                insertSpaces: true,
                wordWrap: 'off',
                scrollBeyondLastLine: false,
                smoothScrolling: true,
                renderWhitespace: 'none',
                renderValidationDecorations: 'off',
                overviewRulerLanes: 0,
                hideCursorInOverviewRuler: true,
                renderLineHighlight: 'none',
                occurrencesHighlight: 'off',
                selectionHighlight: false,
                codeLens: false,
                quickSuggestions: false,
                suggestOnTriggerCharacters: false,
                wordBasedSuggestions: 'off',
                parameterHints: { enabled: false },
                hover: { enabled: false },
                lightbulb: { enabled: 'off' },
                inlineSuggest: { enabled: false },
                inlayHints: { enabled: 'off' },
                bracketPairColorization: { enabled: false },
                stickyScroll: { enabled: false },
                links: false,
                matchBrackets: 'never',
                contextmenu: true,
                padding: { top: 12, bottom: initialBottomPadding },
              });

              editor.onDidChangeModelContent(function () {
                if (suppressChanges) return;
                post({ type: 'change', value: editor.getValue() });
              });

              post({ type: 'ready', value: editor.getValue() });
            }, function (error) {
              post({ type: 'error', message: 'Monaco load failed from ' + base + ': ' + String(error) });
              tryMountMonaco(initialValue, candidateIndex + 1);
            });
          }

          if (window.require && window.require.config) {
            loadFromBase();
            return;
          }

          loadScript(base + '/vs/loader.js', loadFromBase, function () {
            tryMountMonaco(initialValue, candidateIndex + 1);
          });
        }

        try {
          attachCommandBridge();
          var initialValue = decodeBase64Utf8(initialValueBase64);
          tryMountMonaco(initialValue, 0);
        } catch (error) {
          post({ type: 'error', message: String(error) });
          mountFallback('');
        }
      })();
    </script>
  </body>
</html>`;
}
