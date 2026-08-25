/**
 * Prism-based syntax highlighting that never touches the DOM.
 *
 * We import `prismjs/components/prism-core` (no auto-highlight, no `document`
 * access) and pull grammars in on demand. Output is a flat per-line run list —
 * `{ k, n }` pairs where `n` is a character count — so the renderer can slice
 * the original line text without carrying duplicate strings around.
 */

import type { SpanKind } from './types';

// Prism's core reads this before initializing; without it, it tries to attach a
// DOM-ready hook and highlight the document.
const g = globalThis as unknown as { Prism?: Record<string, unknown> };
g.Prism = { ...(g.Prism ?? {}), manual: true, disableWorkerMessageHandler: true };

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Prism = require('prismjs/components/prism-core') as typeof import('prismjs');

/** Character run inside a line: `n` characters classified as `k`. */
export interface SyntaxRun {
    k: SpanKind;
    n: number;
}

const loaded = new Set<string>();

/**
 * Grammars are required through an explicit switch because Metro can't resolve
 * computed require paths. Each case pulls its own dependency chain in order.
 */
function loadGrammar(lang: string): void {
    if (loaded.has(lang)) return;
    loaded.add(lang);
    // Prism's grammar files are browser-style IIFEs that close over a global
    // `Prism`. Bundlers don't always give them the same global our `require`
    // returned, so publish it explicitly before pulling any of them in.
    g.Prism = Prism as unknown as Record<string, unknown>;
    try {
        switch (lang) {
            case 'javascript':
                require('prismjs/components/prism-clike');
                require('prismjs/components/prism-javascript');
                break;
            case 'jsx':
                loadGrammar('javascript');
                require('prismjs/components/prism-markup');
                require('prismjs/components/prism-jsx');
                break;
            case 'typescript':
                loadGrammar('javascript');
                require('prismjs/components/prism-typescript');
                break;
            case 'tsx':
                loadGrammar('jsx');
                loadGrammar('typescript');
                require('prismjs/components/prism-tsx');
                break;
            case 'json':
                require('prismjs/components/prism-json');
                break;
            case 'python':
                require('prismjs/components/prism-python');
                break;
            case 'ruby':
                require('prismjs/components/prism-clike');
                require('prismjs/components/prism-ruby');
                break;
            case 'go':
                require('prismjs/components/prism-clike');
                require('prismjs/components/prism-go');
                break;
            case 'rust':
                require('prismjs/components/prism-rust');
                break;
            case 'java':
                require('prismjs/components/prism-clike');
                require('prismjs/components/prism-java');
                break;
            case 'kotlin':
                require('prismjs/components/prism-clike');
                require('prismjs/components/prism-kotlin');
                break;
            case 'swift':
                require('prismjs/components/prism-swift');
                break;
            case 'objectivec':
                require('prismjs/components/prism-clike');
                require('prismjs/components/prism-c');
                require('prismjs/components/prism-objectivec');
                break;
            case 'c':
                require('prismjs/components/prism-clike');
                require('prismjs/components/prism-c');
                break;
            case 'cpp':
                require('prismjs/components/prism-clike');
                require('prismjs/components/prism-c');
                require('prismjs/components/prism-cpp');
                break;
            case 'csharp':
                require('prismjs/components/prism-clike');
                require('prismjs/components/prism-csharp');
                break;
            case 'php':
                require('prismjs/components/prism-markup-templating');
                require('prismjs/components/prism-php');
                break;
            case 'bash':
                require('prismjs/components/prism-bash');
                break;
            case 'powershell':
                require('prismjs/components/prism-powershell');
                break;
            case 'sql':
                require('prismjs/components/prism-sql');
                break;
            case 'css':
                require('prismjs/components/prism-css');
                break;
            case 'scss':
                require('prismjs/components/prism-css');
                require('prismjs/components/prism-scss');
                break;
            case 'less':
                require('prismjs/components/prism-css');
                require('prismjs/components/prism-less');
                break;
            case 'markup':
                require('prismjs/components/prism-markup');
                break;
            case 'markdown':
                require('prismjs/components/prism-markup');
                require('prismjs/components/prism-markdown');
                break;
            case 'yaml':
                require('prismjs/components/prism-yaml');
                break;
            case 'toml':
                require('prismjs/components/prism-toml');
                break;
            case 'ini':
                require('prismjs/components/prism-ini');
                break;
            case 'docker':
                require('prismjs/components/prism-docker');
                break;
            case 'makefile':
                require('prismjs/components/prism-makefile');
                break;
            case 'cmake':
                require('prismjs/components/prism-cmake');
                break;
            case 'graphql':
                require('prismjs/components/prism-graphql');
                break;
            case 'protobuf':
                require('prismjs/components/prism-clike');
                require('prismjs/components/prism-protobuf');
                break;
            case 'hcl':
                require('prismjs/components/prism-hcl');
                break;
            case 'dart':
                require('prismjs/components/prism-clike');
                require('prismjs/components/prism-dart');
                break;
            case 'lua':
                require('prismjs/components/prism-lua');
                break;
            case 'elixir':
                require('prismjs/components/prism-elixir');
                break;
            case 'scala':
                require('prismjs/components/prism-clike');
                require('prismjs/components/prism-java');
                require('prismjs/components/prism-scala');
                break;
            case 'haskell':
                require('prismjs/components/prism-haskell');
                break;
            case 'perl':
                require('prismjs/components/prism-perl');
                break;
            case 'r':
                require('prismjs/components/prism-r');
                break;
            case 'zig':
                require('prismjs/components/prism-zig');
                break;
            case 'nim':
                require('prismjs/components/prism-nim');
                break;
            case 'erlang':
                require('prismjs/components/prism-erlang');
                break;
            case 'ignore':
            case 'diff':
            default:
                break;
        }
    } catch {
        // A missing grammar just means plain text; never break rendering over it.
    }
}

export function hasGrammar(lang: string | null): boolean {
    if (!lang) return false;
    loadGrammar(lang);
    return Boolean((Prism.languages as Record<string, unknown>)[lang]);
}

/** Collapses Prism's ~80 token names into the dozen colors the theme defines. */
function classify(type: string): SpanKind {
    switch (type) {
        case 'keyword':
        case 'boolean':
        case 'null':
        case 'important':
        case 'atrule':
        case 'rule':
        case 'directive':
        case 'entity':
            return 'keyword';
        case 'string':
        case 'char':
        case 'regex':
        case 'template-string':
        case 'attr-value':
        case 'url':
            return 'string';
        case 'comment':
        case 'prolog':
        case 'doctype':
        case 'cdata':
        case 'docstring':
            return 'comment';
        case 'number':
        case 'hexcode':
        case 'unit':
            return 'number';
        case 'function':
        case 'method':
        case 'function-variable':
        case 'macro':
            return 'function';
        case 'class-name':
        case 'builtin':
        case 'symbol':
        case 'namespace':
        case 'selector':
            return 'type';
        case 'operator':
        case 'arrow':
            return 'operator';
        case 'punctuation':
        case 'interpolation-punctuation':
            return 'punctuation';
        case 'tag':
        case 'script':
            return 'tag';
        case 'attr-name':
        case 'property':
        case 'parameter':
            return 'attr';
        case 'variable':
        case 'constant':
            return 'variable';
        default:
            return 'plain';
    }
}

/** Appends a run, merging with the previous one when the class matches. */
function push(runs: SyntaxRun[], k: SpanKind, n: number): void {
    if (n <= 0) return;
    const last = runs[runs.length - 1];
    if (last && last.k === k) last.n += n;
    else runs.push({ k, n });
}

/**
 * Tokenizes `text` and returns one run list per line.
 *
 * Highlighting is context sensitive (block comments, template strings), so
 * callers should pass a whole contiguous region — we tokenize the reconstructed
 * side of a hunk rather than each line in isolation.
 */
export function highlightLines(text: string, lang: string | null): SyntaxRun[][] {
    const lineCount = text.length === 0 ? 1 : text.split('\n').length;
    if (!lang || !hasGrammar(lang)) {
        // One plain run per line; cheap and lets the renderer take one path.
        return text.split('\n').map((l) => (l.length ? [{ k: 'plain' as SpanKind, n: l.length }] : []));
    }

    const grammar = (Prism.languages as Record<string, unknown>)[lang] as import('prismjs').Grammar;
    let tokens: (string | import('prismjs').Token)[];
    try {
        tokens = Prism.tokenize(text, grammar);
    } catch {
        return text.split('\n').map((l) => (l.length ? [{ k: 'plain' as SpanKind, n: l.length }] : []));
    }

    const out: SyntaxRun[][] = [];
    let current: SyntaxRun[] = [];

    const emit = (chunk: string, k: SpanKind) => {
        let start = 0;
        while (true) {
            const nl = chunk.indexOf('\n', start);
            if (nl === -1) {
                push(current, k, chunk.length - start);
                return;
            }
            push(current, k, nl - start);
            out.push(current);
            current = [];
            start = nl + 1;
        }
    };

    const walk = (node: string | import('prismjs').Token | (string | import('prismjs').Token)[], inherited: SpanKind) => {
        if (typeof node === 'string') {
            emit(node, inherited);
            return;
        }
        if (Array.isArray(node)) {
            for (const child of node) walk(child, inherited);
            return;
        }
        const kind = classify(node.type);
        const effective = kind === 'plain' ? inherited : kind;
        walk(node.content as string | import('prismjs').Token | (string | import('prismjs').Token)[], effective);
    };

    walk(tokens, 'plain');
    out.push(current);

    // Defensive: token walking must not change the line count.
    while (out.length < lineCount) out.push([]);
    return out;
}
