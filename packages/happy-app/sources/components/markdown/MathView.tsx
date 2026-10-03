/**
 * LaTeX math rendering for markdown (native: iOS / Android).
 *
 * Mirrors the MermaidRenderer strategy: math is rendered by KaTeX inside a
 * `react-native-webview`, with the library loaded from the jsDelivr CDN (same
 * transport Mermaid already relies on). Three entry points:
 *
 *   - `MathBlock`      — a display equation on its own line (`$$…$$` / `\[…\]`).
 *   - `InlineMathRun`  — a whole text run (paragraph / list item / header) that
 *                        contains inline math. RN `<Text>` can't hold arbitrary
 *                        inline views, so the entire run is rendered as one
 *                        WebView (KaTeX auto-render) to keep text + math flowing
 *                        together. Non-math runs keep the native `<Text>` path.
 *   - `MathInline`     — fallback for a stray inline-math span reached outside a
 *                        run wrapper (e.g. a table cell): shows the raw TeX.
 *
 * The web build lives in `MathView.web.tsx` (KaTeX via dynamic import, inline).
 */
import * as React from 'react';
import { View, Text } from 'react-native';
import { WebView } from 'react-native-webview';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import type { MarkdownSpan } from './parseMarkdown';
import { isHttpMarkdownLink } from './linkUtils';

const KATEX_VERSION = '0.16.11';
const KATEX_BASE = `https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist`;

// Escape text destined for an HTML text node. Applied to both prose and to the
// TeX source: KaTeX auto-render reads `textContent` (entity-decoded), so escaping
// `<`, `>`, `&` keeps the HTML parser from mangling TeX like `a < b` while the
// math still renders correctly.
function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const HEIGHT_REPORT_SCRIPT = `
    var lastH = 0;
    function reportHeight() {
        if (!window.ReactNativeWebView) return;
        var h = Math.ceil(document.body.scrollHeight);
        if (h === lastH || h <= 0) return;
        lastH = h;
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'dimensions', height: h }));
    }
    requestAnimationFrame(reportHeight);
    window.addEventListener('load', reportHeight);
    if (window.ResizeObserver) { new ResizeObserver(reportHeight).observe(document.body); }
`;

// Shared WebView container: fixed width (100%), auto-growing height driven by the
// page's postMessage. `initialHeight` keeps first paint from collapsing to zero.
function MathWebView(props: { html: string; initialHeight: number; marginVertical?: number; onLinkPress?: (url: string) => void }) {
    const [height, setHeight] = React.useState(props.initialHeight);

    return (
        <View style={[styles.webContainer, { height, marginVertical: props.marginVertical ?? 8 }]}>
            <WebView
                source={{ html: props.html }}
                style={styles.webview}
                scrollEnabled={false}
                originWhitelist={['*']}
                // Transparent so the equation blends into the message bubble.
                // @ts-ignore - RN WebView types omit this but it works on both platforms
                backgroundColor="transparent"
                onShouldStartLoadWithRequest={(req) => {
                    // Allow the initial inline-HTML load; route real link taps out.
                    if (req.url === 'about:blank' || req.url.startsWith('data:') || req.url.startsWith('about:')) {
                        return true;
                    }
                    if (/^https?:\/\//.test(req.url)) {
                        props.onLinkPress?.(req.url);
                        return false;
                    }
                    return false;
                }}
                onMessage={(event) => {
                    try {
                        const data = JSON.parse(event.nativeEvent.data);
                        if (data.type === 'dimensions' && typeof data.height === 'number' && data.height > 0) {
                            setHeight(data.height);
                        }
                    } catch {
                        // Ignore malformed messages
                    }
                }}
            />
        </View>
    );
}

// Display equation on its own line.
export const MathBlock = React.memo((props: { content: string; display?: boolean }) => {
    const { theme } = useUnistyles();
    const display = props.display !== false;

    const html = React.useMemo(() => `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${KATEX_BASE}/katex.min.css">
<script src="${KATEX_BASE}/katex.min.js"></script>
<style>
  html, body { margin: 0; padding: 0; background: transparent; }
  body { color: ${theme.colors.text}; padding: 6px 2px; }
  #eq { overflow-x: auto; overflow-y: hidden; }
  .katex-display { margin: 0; }
  .math-error { color: #ff6b6b; font-family: monospace; white-space: pre-wrap; font-size: 14px; }
</style>
</head>
<body>
<div id="eq"></div>
<script>
  (function () {
    var el = document.getElementById('eq');
    try {
      katex.render(${JSON.stringify(props.content).replace(/</g, '\\u003c')}, el, { displayMode: ${display}, throwOnError: false });
    } catch (e) {
      el.innerHTML = '<span class="math-error">' + String((e && e.message) || e).replace(/</g, '&lt;') + '</span>';
    }
${HEIGHT_REPORT_SCRIPT}
  })();
</script>
</body>
</html>`, [props.content, display, theme.colors.text]);

    return <MathWebView html={html} initialHeight={display ? 56 : 28} />;
});

type RunTextStyle = { fontSize: number; bold?: boolean; lineHeight?: number };

// A text run (paragraph / list item / header) that contains inline math.
// Rendered as one WebView so text and inline math flow together.
export const InlineMathRun = React.memo((props: {
    spans: MarkdownSpan[];
    textStyle: RunTextStyle;
    compact?: boolean;
    onLinkPress?: (url: string) => void;
}) => {
    const { theme } = useUnistyles();
    const { fontSize, bold, lineHeight } = props.textStyle;
    const color = theme.colors.text;

    const body = React.useMemo(() => spansToHtml(props.spans), [props.spans]);

    const html = React.useMemo(() => `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${KATEX_BASE}/katex.min.css">
<script src="${KATEX_BASE}/katex.min.js"></script>
<style>
  html, body { margin: 0; padding: 0; background: transparent; }
  body {
    color: ${color};
    font-size: ${fontSize}px;
    line-height: ${lineHeight ?? Math.round(fontSize * 1.5)}px;
    font-weight: ${bold ? 700 : 400};
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }
  a { color: ${color}; text-decoration: underline; }
  code { font-family: 'IBM Plex Mono', ui-monospace, monospace; }
  .katex { font-size: 1em; }
  .math-error { color: #ff6b6b; font-family: monospace; }
</style>
</head>
<body>
<div id="run">${body}</div>
<script>
  (function () {
    // Render each placeholder from its data-tex — no delimiter text-scan, so a
    // stray backslash-paren in prose can't be mistaken for a math delimiter.
    var nodes = document.querySelectorAll('#run .km');
    for (var i = 0; i < nodes.length; i++) {
      try {
        katex.render(nodes[i].getAttribute('data-tex'), nodes[i], { throwOnError: false, displayMode: false });
      } catch (e) {}
    }
${HEIGHT_REPORT_SCRIPT}
  })();
</script>
</body>
</html>`, [body, color, fontSize, bold, lineHeight]);

    return <MathWebView html={html} initialHeight={lineHeight ?? Math.round(fontSize * 1.5)} marginVertical={props.compact ? 0 : 8} onLinkPress={props.onLinkPress} />;
});

// Build an HTML fragment from spans: prose is escaped + styled, math spans become
// KaTeX auto-render delimiters (with the TeX escaped so the HTML parser is happy).
function spansToHtml(spans: MarkdownSpan[]): string {
    let html = '';
    for (const span of spans) {
        if (span.math) {
            // Empty placeholder carrying the TeX in an attribute; the page renders
            // each one with katex.render (inline mode), so prose is never scanned
            // for delimiters and can't collide with a real equation.
            html += `<span class="km" data-tex="${escapeHtml(span.text)}"></span>`;
            continue;
        }
        let piece = escapeHtml(span.text);
        if (span.styles.includes('code')) piece = `<code>${piece}</code>`;
        if (span.styles.includes('bold')) piece = `<strong>${piece}</strong>`;
        if (span.styles.includes('semibold')) piece = `<span style="font-weight:600">${piece}</span>`;
        if (span.styles.includes('italic')) piece = `<em>${piece}</em>`;
        // Only linkify http(s) — matches the sanitization the native <Text> path
        // enforces via isHttpMarkdownLink; a javascript:/other-scheme url stays text.
        if (span.url && isHttpMarkdownLink(span.url)) piece = `<a href="${escapeHtml(span.url)}">${piece}</a>`;
        html += piece;
    }
    return html;
}

// Fallback for a stray inline-math span rendered outside an InlineMathRun wrapper
// (native can't put a WebView inside a <Text>, so show the raw TeX). Web renders
// this properly — see MathView.web.tsx.
export function MathInline(props: { tex: string; style?: any }) {
    return <Text style={[styles.inlineFallback, props.style]}>{props.tex}</Text>;
}

const styles = StyleSheet.create((theme) => ({
    webContainer: {
        width: '100%',
    },
    webview: {
        flex: 1,
        backgroundColor: 'transparent',
    },
    inlineFallback: {
        ...Typography.mono(),
        color: theme.colors.text,
    },
}));
