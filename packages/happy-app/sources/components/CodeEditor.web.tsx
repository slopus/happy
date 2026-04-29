/**
 * Web-only code editor with syntax highlighting.
 * Uses react-simple-code-editor + Prism.js.
 * Theme colors match the app's syntax highlighting (Pierre-consistent).
 */
import * as React from 'react';
import Editor from 'react-simple-code-editor';
import Prism from 'prismjs';

// Load Prism languages (order matters — dependencies first)
import 'prismjs/components/prism-markup';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-toml';
import 'prismjs/components/prism-ini';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-docker';
import 'prismjs/components/prism-graphql';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-c';
import 'prismjs/components/prism-cpp';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-ruby';
import 'prismjs/components/prism-swift';
import 'prismjs/components/prism-kotlin';
import 'prismjs/components/prism-hcl';

interface CodeEditorProps {
    value: string;
    onChange: (value: string) => void;
    language: string | null;
    darkMode: boolean;
    readOnly?: boolean;
}

const LANG_MAP: Record<string, string> = {
    javascript: 'javascript',
    typescript: 'typescript',
    jsx: 'jsx',
    tsx: 'tsx',
    python: 'python',
    html: 'markup',
    css: 'css',
    json: 'json',
    markdown: 'markdown',
    xml: 'markup',
    yaml: 'yaml',
    toml: 'toml',
    ini: 'ini',
    bash: 'bash',
    shell: 'bash',
    docker: 'docker',
    graphql: 'graphql',
    sql: 'sql',
    go: 'go',
    rust: 'rust',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    ruby: 'ruby',
    swift: 'swift',
    kotlin: 'kotlin',
    hcl: 'hcl',
};

export const CodeEditor = React.memo(function CodeEditor({
    value,
    onChange,
    language,
    darkMode,
    readOnly = false,
}: CodeEditorProps) {
    const highlight = React.useCallback((code: string) => {
        const prismLang = language ? (LANG_MAP[language] ?? null) : null;
        const grammar = prismLang ? Prism.languages[prismLang] : null;
        if (!grammar || !prismLang) return escapeHtml(code);
        try {
            return Prism.highlight(code, grammar, prismLang);
        } catch {
            return escapeHtml(code);
        }
    }, [language]);

    // Inject theme CSS into document head
    React.useEffect(() => {
        const id = 'prism-editor-theme';
        let el = document.getElementById(id);
        if (!el) {
            el = document.createElement('style');
            el.id = id;
            document.head.appendChild(el);
        }
        el.textContent = darkMode ? DARK_THEME_CSS : LIGHT_THEME_CSS;
    }, [darkMode]);

    return (
        <div
            style={{
                flex: 1,
                overflow: 'auto',
                backgroundColor: darkMode ? '#1e1e1e' : '#ffffff',
            }}
        >
            <Editor
                value={value}
                onValueChange={readOnly ? () => {} : onChange}
                highlight={highlight}
                padding={16}
                readOnly={readOnly}
                style={{
                    fontFamily: 'ui-monospace, "SF Mono", "Cascadia Code", "Segoe UI Mono", Menlo, Monaco, Consolas, monospace',
                    fontSize: 14,
                    lineHeight: 1.5,
                    minHeight: '100%',
                    color: darkMode ? '#D4D4D4' : '#374151',
                    backgroundColor: 'transparent',
                }}
                textareaClassName="code-editor-textarea"
            />
        </div>
    );
});

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Colors from theme.ts dark mode (matches Pierre github-dark-default)
const DARK_THEME_CSS = `
.code-editor-textarea {
    outline: none !important;
    caret-color: #fff !important;
}
.token.comment, .token.prolog, .token.doctype, .token.cdata { color: #6A9955; font-style: italic; }
.token.punctuation { color: #D4D4D4; }
.token.property, .token.tag, .token.boolean, .token.number, .token.constant, .token.symbol { color: #B5CEA8; }
.token.selector, .token.attr-name, .token.string, .token.char, .token.builtin, .token.inserted { color: #CE9178; }
.token.operator, .token.entity, .token.url { color: #D4D4D4; }
.token.atrule, .token.attr-value, .token.keyword, .token.class-name { color: #569CD6; }
.token.function { color: #DCDCAA; }
.token.regex, .token.important, .token.variable { color: #D16969; }
.token.deleted { color: #CE9178; text-decoration: line-through; }
.token.namespace { color: #4EC9B0; }
.token.tag .token.punctuation { color: #808080; }
.token.tag .token.attr-name { color: #9CDCFE; }
.token.tag .token.attr-value { color: #CE9178; }
`;

// Colors from theme.ts light mode
const LIGHT_THEME_CSS = `
.code-editor-textarea {
    outline: none !important;
    caret-color: #000 !important;
}
.token.comment, .token.prolog, .token.doctype, .token.cdata { color: #6b7280; font-style: italic; }
.token.punctuation { color: #374151; }
.token.property, .token.tag, .token.boolean, .token.number, .token.constant, .token.symbol { color: #0891b2; }
.token.selector, .token.attr-name, .token.string, .token.char, .token.builtin, .token.inserted { color: #059669; }
.token.operator, .token.entity, .token.url { color: #374151; }
.token.atrule, .token.attr-value, .token.keyword, .token.class-name { color: #1d4ed8; }
.token.function { color: #9333ea; }
.token.regex, .token.important, .token.variable { color: #dc2626; }
.token.deleted { color: #dc2626; text-decoration: line-through; }
.token.namespace { color: #0d9488; }
.token.tag .token.punctuation { color: #6b7280; }
.token.tag .token.attr-name { color: #1d4ed8; }
.token.tag .token.attr-value { color: #059669; }
`;
