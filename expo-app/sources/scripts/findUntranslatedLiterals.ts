#!/usr/bin/env tsx

import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';

type Finding = {
    file: string;
    line: number;
    col: number;
    kind: 'jsx-text' | 'jsx-attr' | 'call-arg';
    text: string;
    context: string;
};

const projectRoot = path.resolve(__dirname, '../..');
const sourcesRoot = path.join(projectRoot, 'sources');

const EXCLUDE_DIRS = new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    'coverage',
]);

function isUnder(dir: string, filePath: string): boolean {
    const rel = path.relative(dir, filePath);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function walk(dir: string, out: string[]) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (EXCLUDE_DIRS.has(entry.name)) continue;
            walk(full, out);
            continue;
        }
        if (!entry.isFile()) continue;
        if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;
        out.push(full);
    }
}

function getLineAndCol(sourceFile: ts.SourceFile, pos: number): { line: number; col: number } {
    const lc = sourceFile.getLineAndCharacterOfPosition(pos);
    return { line: lc.line + 1, col: lc.character + 1 };
}

function normalizeText(s: string): string {
    return s.replace(/\s+/g, ' ').trim();
}

function shouldIgnoreLiteral(text: string): boolean {
    const t = normalizeText(text);
    if (!t) return true;

    // Likely not user-facing / or intentionally not translated
    if (t.startsWith('http://') || t.startsWith('https://')) return true;
    if (/^[A-Z0-9_]{3,}$/.test(t)) return true; // ENV keys, constants
    if (/^[a-z0-9._/-]+$/.test(t) && t.length <= 32) return true; // ids/paths/slugs
    if (/^#[0-9a-f]{3,8}$/i.test(t)) return true;
    if (/^\d+(\.\d+)*$/.test(t)) return true;

    // Single punctuation / trivial
    if (/^[•·\-\u2013\u2014]+$/.test(t)) return true;

    return false;
}

const USER_FACING_ATTRS = new Set([
    'title',
    'subtitle',
    'description',
    'message',
    'label',
    'placeholder',
    'hint',
    'helperText',
    'emptyTitle',
    'emptyDescription',
    'confirmText',
    'cancelText',
    'text',
    'header',
]);

function isTCall(node: ts.Node): boolean {
    if (!ts.isCallExpression(node)) return false;
    if (ts.isIdentifier(node.expression)) return node.expression.text === 't';
    return false;
}

function getNodeText(sourceFile: ts.SourceFile, node: ts.Node): string {
    return sourceFile.text.slice(node.getStart(sourceFile), node.getEnd());
}

function takeContextLine(source: string, line: number): string {
    const lines = source.split(/\r?\n/);
    return lines[Math.max(0, Math.min(lines.length - 1, line - 1))]?.trim() ?? '';
}

function scanFile(filePath: string): Finding[] {
    const rel = path.relative(projectRoot, filePath);

    // Ignore translation sources and scripts
    if (rel.includes(`sources${path.sep}text${path.sep}translations${path.sep}`)) return [];
    if (rel.includes(`sources${path.sep}text${path.sep}_default`)) return [];
    if (rel.includes(`sources${path.sep}scripts${path.sep}`)) return [];

    const sourceText = fs.readFileSync(filePath, 'utf8');
    const scriptKind =
        filePath.endsWith('.tsx')
            ? ts.ScriptKind.TSX
            : filePath.endsWith('.ts')
                ? ts.ScriptKind.TS
                : filePath.endsWith('.jsx')
                    ? ts.ScriptKind.JSX
                    : ts.ScriptKind.JS;
    const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, scriptKind);

    const findings: Finding[] = [];

    const visit = (node: ts.Node) => {
        // JSX text nodes: <Text>Some string</Text>
        if (ts.isJsxText(node)) {
            const value = normalizeText(node.getText(sourceFile));
            if (value && !shouldIgnoreLiteral(value)) {
                const { line, col } = getLineAndCol(sourceFile, node.getStart(sourceFile));
                findings.push({
                    file: rel,
                    line,
                    col,
                    kind: 'jsx-text',
                    text: value,
                    context: takeContextLine(sourceText, line),
                });
            }
        }

        // JSX attributes: title="Some"
        if (ts.isJsxAttribute(node) && node.initializer) {
            const attrName = node.name.getText(sourceFile);
            if (USER_FACING_ATTRS.has(attrName)) {
                const init = node.initializer;
                if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
                    const value = normalizeText(init.text);
                    if (value && !shouldIgnoreLiteral(value)) {
                        const { line, col } = getLineAndCol(sourceFile, init.getStart(sourceFile));
                        findings.push({
                            file: rel,
                            line,
                            col,
                            kind: 'jsx-attr',
                            text: value,
                            context: takeContextLine(sourceText, line),
                        });
                    }
                }
            }
        }

        // Call args: Modal.alert("Error", "…")
        if (ts.isCallExpression(node) && !isTCall(node)) {
            const exprText = getNodeText(sourceFile, node.expression);
            const isLikelyUiAlert =
                exprText.endsWith('.alert') ||
                exprText.endsWith('.confirm') ||
                exprText.endsWith('.prompt') ||
                exprText.includes('Toast') ||
                exprText.includes('Modal');

            if (isLikelyUiAlert) {
                for (const arg of node.arguments) {
                    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
                        const value = normalizeText(arg.text);
                        if (value && !shouldIgnoreLiteral(value)) {
                            const { line, col } = getLineAndCol(sourceFile, arg.getStart(sourceFile));
                            findings.push({
                                file: rel,
                                line,
                                col,
                                kind: 'call-arg',
                                text: value,
                                context: takeContextLine(sourceText, line),
                            });
                        }
                    }
                }
            }
        }

        ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    // Deduplicate exact same hits (common when JSXText includes leading/trailing whitespace)
    const seen = new Set<string>();
    const unique: Finding[] = [];
    for (const f of findings) {
        const key = `${f.file}:${f.line}:${f.col}:${f.kind}:${f.text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(f);
    }
    return unique;
}

const files: string[] = [];
const args = process.argv.slice(2);
if (args.length === 0) {
    walk(sourcesRoot, files);
} else {
    for (const arg of args) {
        const full = path.isAbsolute(arg) ? arg : path.join(projectRoot, arg);
        if (!fs.existsSync(full)) continue;
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
            walk(full, files);
        } else if (stat.isFile() && /\.(ts|tsx|js|jsx)$/.test(full)) {
            files.push(full);
        }
    }
}

const all: Finding[] = [];
for (const filePath of files) {
    all.push(...scanFile(filePath));
}

all.sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    if (a.line !== b.line) return a.line - b.line;
    return a.col - b.col;
});

const grouped = new Map<string, Finding[]>();
for (const f of all) {
    const key = `${f.kind}:${f.text}`;
    const list = grouped.get(key) ?? [];
    list.push(f);
    grouped.set(key, list);
}

console.log(`# Potential Untranslated UI Literals (${all.length} findings)\n`);
console.log(`Scanned: ${files.length} source files under ${path.relative(projectRoot, sourcesRoot)}\n`);

for (const [key, list] of grouped.entries()) {
    const colonIndex = key.indexOf(':');
    const kind = colonIndex >= 0 ? key.slice(0, colonIndex) : key;
    const text = colonIndex >= 0 ? key.slice(colonIndex + 1) : '';
    console.log(`- ${kind}: "${text}" (${list.length} occurrence${list.length === 1 ? '' : 's'})`);
    for (const f of list.slice(0, 10)) {
        console.log(`  - ${f.file}:${f.line}:${f.col}  ${f.context}`);
    }
    if (list.length > 10) {
        console.log(`  - … ${list.length - 10} more`);
    }
}
