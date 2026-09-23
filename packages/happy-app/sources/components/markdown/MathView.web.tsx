/**
 * LaTeX math rendering for markdown (web).
 *
 * KaTeX is loaded via dynamic `import('katex')` (a lazy chunk, mirroring how
 * MermaidRenderer imports mermaid on web) and its stylesheet is injected once
 * from the jsDelivr CDN. Unlike native, web `<Text>` renders as a `<div>`, so
 * inline math flows naturally inside prose — `MathInline` renders a `<span>`
 * that inherits the surrounding text color, and there's no need to route whole
 * runs through a WebView. `InlineMathRun` therefore exists only to satisfy the
 * shared import from MarkdownView; on web the inline path goes through
 * `MathInline` (per-span) instead.
 *
 * Native lives in `MathView.tsx`.
 */
import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { MarkdownSpan } from './parseMarkdown';

const KATEX_VERSION = '0.16.11';
const KATEX_BASE = `https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist`;

let cssInjected = false;
function ensureKatexCss() {
    if (cssInjected || typeof document === 'undefined') return;
    cssInjected = true;
    if (document.getElementById('katex-css')) return;
    const link = document.createElement('link');
    link.id = 'katex-css';
    link.rel = 'stylesheet';
    link.href = `${KATEX_BASE}/katex.min.css`;
    document.head.appendChild(link);
}

let katexPromise: Promise<any> | null = null;
function loadKatex(): Promise<any> {
    ensureKatexCss();
    if (!katexPromise) {
        // Clear the cache on failure so a later mount can retry (a permanently
        // rejected promise would leave every equation as raw TeX until reload).
        katexPromise = import('katex')
            .then((m: any) => m.default || m)
            .catch((e) => { katexPromise = null; throw e; });
    }
    return katexPromise;
}

// Render TeX to an HTML string once KaTeX resolves.
function useKatexHtml(tex: string, display: boolean): string | null {
    const [html, setHtml] = React.useState<string | null>(null);
    React.useEffect(() => {
        let mounted = true;
        loadKatex()
            .then((katex) => {
                if (!mounted) return;
                try {
                    setHtml(katex.renderToString(tex, { displayMode: display, throwOnError: false }));
                } catch (e) {
                    setHtml(`<span style="color:#ff6b6b;font-family:monospace">${escapeHtml(tex)}</span>`);
                }
            })
            .catch(() => {
                if (mounted) setHtml(`<span style="font-family:monospace">${escapeHtml(tex)}</span>`);
            });
        return () => { mounted = false; };
    }, [tex, display]);
    return html;
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Display equation on its own line.
export const MathBlock = React.memo((props: { content: string; display?: boolean }) => {
    const { theme } = useUnistyles();
    const display = props.display !== false;
    const html = useKatexHtml(props.content, display);

    if (html === null) {
        return <div style={{ height: display ? 40 : 20, marginTop: 6, marginBottom: 6 }} />;
    }
    return (
        <div
            style={{ overflowX: 'auto', overflowY: 'hidden', marginTop: 8, marginBottom: 8, color: theme.colors.text }}
            dangerouslySetInnerHTML={{ __html: html }}
        />
    );
});

// Inline math span — always inline mode (displayMode:false) so it flows inside
// the surrounding text (inheriting its color) rather than breaking out as a
// centered `.katex-display` block, even for an inline `$$…$$`.
export const MathInline = React.memo((props: { tex: string; style?: any }) => {
    const html = useKatexHtml(props.tex, false);
    if (html === null) {
        return <span style={props.style}>{props.tex}</span>;
    }
    return <span style={props.style} dangerouslySetInnerHTML={{ __html: html }} />;
});

type RunTextStyle = { fontSize: number; bold?: boolean; lineHeight?: number };

// Web never routes a run through here (MarkdownView keeps the native <Text> +
// per-span MathInline path on web); this exists to satisfy the shared import and
// renders a correct inline flow if ever called.
export const InlineMathRun = React.memo((props: {
    spans: MarkdownSpan[];
    textStyle: RunTextStyle;
    compact?: boolean;
    onLinkPress?: (url: string) => void;
}) => {
    const { theme } = useUnistyles();
    const { fontSize, bold, lineHeight } = props.textStyle;
    const color = theme.colors.text;
    return (
        <div style={{ fontSize, color, fontWeight: bold ? 700 : 400, lineHeight: `${lineHeight ?? Math.round(fontSize * 1.5)}px` }}>
            {props.spans.map((span, i) => {
                if (span.math) {
                    return <MathInline key={i} tex={span.text} />;
                }
                if (span.url) {
                    return (
                        <a key={i} href={span.url} onClick={(e) => { e.preventDefault(); props.onLinkPress?.(span.url!); }} style={{ color, textDecoration: 'underline' }}>
                            {span.text}
                        </a>
                    );
                }
                return <span key={i}>{span.text}</span>;
            })}
        </div>
    );
});
