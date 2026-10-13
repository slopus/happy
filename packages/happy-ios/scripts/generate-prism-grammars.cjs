#!/usr/bin/env node
/*
 * Generates Sources/HappyCore/Diff/Syntax/PrismGrammars.generated.swift from
 * the Prism grammars happy-app highlights diffs with
 * (components/diff/engine/highlight.ts).
 *
 *   node scripts/generate-prism-grammars.cjs <node_modules> [--check]
 *   node scripts/generate-prism-grammars.cjs <node_modules> --reference <out.json> <language>:<file>...
 *
 * `--reference` writes what highlight.ts's highlightLines gives for each
 * file instead; `PRISM_CORPUS=<out.json> swift test --filter
 * PrismCorpusTests` compares the Swift port with it run for run.
 *
 * <node_modules> must hold prismjs (the version happy-app pins) and
 * @eslint-community/regexpp, which parses each pattern so it can be
 * rewritten for ICU (NSRegularExpression) with JavaScript's meaning:
 *
 *   - `.`, `\d`, `\w`, `\s`, `\b` and `^` / `$` (with and without `m`)
 *     become explicit sets and lookarounds, since ICU's are Unicode-aware
 *     and its anchors differ.
 *   - Every literal outside [A-Za-z0-9] is escaped, so ICU's class set
 *     operators (`[`, `&&`, `--`) never apply.
 *   - Backreferences are wrapped, so a following digit stays a digit.
 *
 * Grammars load in highlight.ts's switch order into one Prism, the way a
 * long-lived worker ends up with them all. A grammar's `rest` is merged the
 * way Prism.tokenize merges it. Each grammar object is written once and
 * referred to by index, so `inside` can point back at a language.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const check = args.includes('--check');
const referenceAt = args.indexOf('--reference');
const modules = args[0];
if (!modules || modules.startsWith('--')) {
    console.error('usage: generate-prism-grammars.cjs <node_modules> [--check | --reference <out.json> <language>:<file>...]');
    process.exit(2);
}
const output = path.join(__dirname, '..', 'Sources/HappyCore/Diff/Syntax/PrismGrammars.generated.swift');
const load = (name) => require(path.join(path.resolve(modules), name));

// highlight.ts's loadGrammar, case by case. `@x` loads another case first.
const chains = [
    ['javascript', ['clike', 'javascript']],
    ['jsx', ['@javascript', 'markup', 'jsx']],
    ['typescript', ['@javascript', 'typescript']],
    ['tsx', ['@jsx', '@typescript', 'tsx']],
    ['json', ['json']],
    ['python', ['python']],
    ['ruby', ['clike', 'ruby']],
    ['go', ['clike', 'go']],
    ['rust', ['rust']],
    ['java', ['clike', 'java']],
    ['kotlin', ['clike', 'kotlin']],
    ['swift', ['swift']],
    ['objectivec', ['clike', 'c', 'objectivec']],
    ['c', ['clike', 'c']],
    ['cpp', ['clike', 'c', 'cpp']],
    ['csharp', ['clike', 'csharp']],
    ['php', ['markup-templating', 'php']],
    ['bash', ['bash']],
    ['shell-session', ['@bash', 'shell-session']],
    ['powershell', ['powershell']],
    ['sql', ['sql']],
    ['css', ['css']],
    ['scss', ['css', 'scss']],
    ['less', ['css', 'less']],
    ['markup', ['markup']],
    ['markdown', ['markup', 'markdown']],
    ['yaml', ['yaml']],
    ['toml', ['toml']],
    ['ini', ['ini']],
    ['docker', ['docker']],
    ['makefile', ['makefile']],
    ['cmake', ['cmake']],
    ['graphql', ['graphql']],
    ['protobuf', ['clike', 'protobuf']],
    ['hcl', ['hcl']],
    ['dart', ['clike', 'dart']],
    ['lua', ['lua']],
    ['elixir', ['elixir']],
    ['scala', ['clike', 'java', 'scala']],
    ['haskell', ['haskell']],
    ['perl', ['perl']],
    ['r', ['r']],
    ['zig', ['zig']],
    ['nim', ['nim']],
    ['erlang', ['erlang']],
];

globalThis.Prism = { manual: true, disableWorkerMessageHandler: true };
const prism = load('prismjs/components/prism-core');
const cases = new Map(chains);
const loaded = new Set();
function loadCase(name) {
    if (loaded.has(name)) return;
    loaded.add(name);
    globalThis.Prism = prism;
    for (const step of cases.get(name)) {
        if (step.startsWith('@')) loadCase(step.slice(1));
        else load(`prismjs/components/prism-${step}`);
    }
}
for (const [name] of chains) loadCase(name);

if (referenceAt !== -1) {
    writeReference(args[referenceAt + 1], args.slice(referenceAt + 2));
    process.exit(0);
}

/** highlight.ts's classify and highlightLines, verbatim in behaviour. */
function writeReference(out, specs) {
    const kinds = {
        keyword: ['keyword', 'boolean', 'null', 'important', 'atrule', 'rule', 'directive', 'entity'],
        string: ['string', 'char', 'regex', 'template-string', 'attr-value', 'url'],
        comment: ['comment', 'prolog', 'doctype', 'cdata', 'docstring'],
        number: ['number', 'hexcode', 'unit'],
        function: ['function', 'method', 'function-variable', 'macro'],
        type: ['class-name', 'builtin', 'symbol', 'namespace', 'selector'],
        operator: ['operator', 'arrow'],
        punctuation: ['punctuation', 'interpolation-punctuation'],
        tag: ['tag', 'script'],
        attr: ['attr-name', 'property', 'parameter'],
        variable: ['variable', 'constant'],
    };
    const classify = (type) => Object.keys(kinds).find((kind) => kinds[kind].includes(type)) ?? 'plain';
    const highlightLines = (text, language) => {
        const lineCount = text.length === 0 ? 1 : text.split('\n').length;
        const out = [];
        let current = [];
        const push = (k, n) => {
            if (n <= 0) return;
            const last = current[current.length - 1];
            if (last && last.k === k) last.n += n;
            else current.push({ k, n });
        };
        const emit = (chunk, k) => {
            const parts = chunk.split('\n');
            parts.forEach((part, index) => {
                if (index > 0) { out.push(current); current = []; }
                push(k, part.length);
            });
        };
        const walk = (node, inherited) => {
            if (typeof node === 'string') return emit(node, inherited);
            if (Array.isArray(node)) return node.forEach((child) => walk(child, inherited));
            const kind = classify(node.type);
            walk(node.content, kind === 'plain' ? inherited : kind);
        };
        walk(prism.tokenize(text, prism.languages[language]), 'plain');
        out.push(current);
        while (out.length < lineCount) out.push([]);
        return out;
    };
    const entries = specs.map((spec) => {
        const at = spec.indexOf(':');
        const language = spec.slice(0, at);
        const file = spec.slice(at + 1);
        // JSONSerialization drops a leading byte order mark; TextDecoder
        // would too.
        const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
        if (!prism.languages[language]) throw new Error(`no grammar for ${language}`);
        return { lang: language, file, text, runs: highlightLines(text, language) };
    });
    fs.writeFileSync(out, JSON.stringify(entries));
    console.log(`Prism reference: ${entries.length} files`);
}

// MARK: Patterns

const { RegExpParser } = load('@eslint-community/regexpp');
const parser = new RegExpParser({ ecmaVersion: 2025, strict: false });

const LINE_TERMINATORS = '\\n\\r\\x{2028}\\x{2029}';
const ANYTHING = '[\\x{0}-\\x{10FFFF}]';
const WORD = 'A-Za-z0-9_';
// JavaScript's WhiteSpace and LineTerminator.
const SPACE = '\\x{9}-\\x{D}\\x{20}\\x{A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}';
const WORD_CHAR = `(?-i:[${WORD}])`;

// Stand-ins for the longest repeated pieces, expanded before compiling.
// Patterns never hold a raw non-ASCII character, so `¶` can't clash.
const macros = [
    ['¶s', SPACE],
    ['¶w', WORD_CHAR],
    ['¶b', `(?:(?<=${WORD_CHAR})(?!${WORD_CHAR})|(?<!${WORD_CHAR})(?=${WORD_CHAR}))`],
    ['¶B', `(?:(?<=${WORD_CHAR})(?=${WORD_CHAR})|(?<!${WORD_CHAR})(?!${WORD_CHAR}))`],
    ['¶.', `[^${LINE_TERMINATORS}]`],
];

function literal(value, inClass) {
    const char = String.fromCodePoint(value);
    if (/[A-Za-z0-9]/.test(char)) return char;
    if (value > 0x20 && value < 0x7f && !(inClass && char === '-')) return '\\' + char;
    if (value >= 0xd800 && value <= 0xdfff) throw new Error(`lone surrogate \\u${value.toString(16)}`);
    return `\\x{${value.toString(16).toUpperCase()}}`;
}

function setBody(node) {
    switch (node.kind) {
        case 'digit': return '0-9';
        case 'word': return WORD;
        case 'space': return '¶s';
        default: throw new Error(`character set ${node.kind}`);
    }
}

function classMember(node) {
    switch (node.type) {
        case 'Character': return literal(node.value, true);
        case 'CharacterClassRange': {
            const { value: min } = node.min;
            const { value: max } = node.max;
            const hex = (value) => `\\x{${value.toString(16).toUpperCase()}}`;
            // JavaScript matches code units: a class holding every surrogate
            // holds every character beyond the BMP too, half at a time.
            if (min <= 0xd800 && max >= 0xdfff) return `${hex(min)}-${hex(max)}\\x{10000}-\\x{10FFFF}`;
            if (max >= 0xd800 && min <= 0xdfff) throw new Error('part of the surrogate range');
            return `${literal(min, true)}-${literal(max, true)}`;
        }
        case 'CharacterSet': return node.negate ? `[^${setBody(node)}]` : setBody(node);
        default: throw new Error(`class member ${node.type}`);
    }
}

function emit(node, flags) {
    const all = (list) => list.map((child) => emit(child, flags)).join('');
    const alternatives = (list) => list.map((child) => emit(child, flags)).join('|');
    switch (node.type) {
        case 'Pattern': return alternatives(node.alternatives);
        case 'Alternative': return all(node.elements);
        case 'Group': return `(?:${alternatives(node.alternatives)})`;
        case 'CapturingGroup':
            if (node.name) throw new Error('named group');
            return `(${alternatives(node.alternatives)})`;
        case 'Quantifier': {
            let element = emit(node.element, flags);
            if (node.element.type === 'Assertion') element = `(?:${element})`;
            const max = node.max === Infinity ? '' : String(node.max);
            let count;
            if (node.min === 0 && node.max === Infinity) count = '*';
            else if (node.min === 1 && node.max === Infinity) count = '+';
            else if (node.min === 0 && node.max === 1) count = '?';
            else if (node.min === node.max) count = `{${node.min}}`;
            else count = `{${node.min},${max}}`;
            return element + count + (node.greedy ? '' : '?');
        }
        case 'CharacterClass': {
            if (node.unicodeSets) throw new Error('v flag');
            if (!node.elements.length) return node.negate ? ANYTHING : '(?!)';
            return `[${node.negate ? '^' : ''}${node.elements.map(classMember).join('')}]`;
        }
        case 'CharacterSet':
            switch (node.kind) {
                case 'any': return flags.dotAll ? ANYTHING : '¶.';
                // JavaScript's \d and \w are ASCII and ignore `i`.
                case 'digit': return `(?-i:[${node.negate ? '^' : ''}0-9])`;
                case 'word': return node.negate ? `(?-i:[^${WORD}])` : '¶w';
                case 'space': return `[${node.negate ? '^' : ''}¶s]`;
                default: throw new Error(`character set ${node.kind}`);
            }
        case 'Character': return literal(node.value, false);
        case 'Backreference':
            if (typeof node.ref !== 'number') throw new Error('named backreference');
            return `(?:\\${node.ref})`;
        case 'Assertion':
            switch (node.kind) {
                case 'start': return flags.multiline ? `(?<![^${LINE_TERMINATORS}])` : `(?<!${ANYTHING})`;
                case 'end': return flags.multiline ? `(?![^${LINE_TERMINATORS}])` : `(?!${ANYTHING})`;
                case 'word': return node.negate ? '¶B' : '¶b';
                case 'lookahead': return `(?${node.negate ? '!' : '='}${alternatives(node.alternatives)})`;
                case 'lookbehind': return `(?<${node.negate ? '!' : '='}${alternatives(node.alternatives)})`;
                default: throw new Error(`assertion ${node.kind}`);
            }
        default:
            throw new Error(`node ${node.type}`);
    }
}

function translate(regex) {
    const flags = { multiline: regex.multiline, dotAll: regex.dotAll };
    if (regex.unicode || regex.unicodeSets || regex.sticky) throw new Error(`flags ${regex.flags}`);
    const ast = parser.parsePattern(regex.source, 0, regex.source.length, { unicode: false });
    return emit(ast, flags);
}

// MARK: Grammars

const ids = new Map();
const grammars = [];
function grammarId(grammar) {
    if (ids.has(grammar)) return ids.get(grammar);
    const id = grammars.length;
    ids.set(grammar, id);
    grammars.push(null);
    // Prism.tokenize: `rest`'s tokens are copied in, replacing same-named
    // ones in place and appending the others, before matching starts.
    const entries = new Map();
    for (const key of Object.keys(grammar)) if (key !== 'rest') entries.set(key, grammar[key]);
    if (grammar.rest) for (const key of Object.keys(grammar.rest)) entries.set(key, grammar.rest[key]);
    const tokens = [];
    for (const [name, value] of entries) {
        if (!value) continue;
        const patterns = (Array.isArray(value) ? value : [value]).map((pattern) => {
            const regex = pattern instanceof RegExp ? pattern : pattern.pattern;
            if (!(regex instanceof RegExp)) throw new Error(`${name}: not a pattern`);
            let source;
            try {
                source = translate(regex);
            } catch (error) {
                throw new Error(`${name}: /${regex.source}/${regex.flags}: ${error.message}`);
            }
            return {
                source,
                ignoreCase: regex.ignoreCase,
                lookbehind: !(pattern instanceof RegExp) && Boolean(pattern.lookbehind),
                greedy: !(pattern instanceof RegExp) && Boolean(pattern.greedy),
                inside: !(pattern instanceof RegExp) && pattern.inside ? grammarId(pattern.inside) : -1,
            };
        });
        tokens.push({ name, patterns });
    }
    grammars[id] = tokens;
    return id;
}

const languages = chains.map(([name]) => {
    const grammar = prism.languages[name];
    if (!grammar) throw new Error(`no grammar for ${name}`);
    return [name, grammarId(grammar)];
});

// MARK: Output

const sources = new Map();
let table = '';
grammars.forEach((tokens, id) => {
    table += `@${id}\n`;
    for (const token of tokens) {
        if (/\s/.test(token.name)) throw new Error(`token name ${token.name}`);
        table += `=${token.name}\n`;
        for (const p of token.patterns) {
            if (!sources.has(p.source)) sources.set(p.source, sources.size);
            const flags = (p.ignoreCase ? 'i' : '-') + (p.lookbehind ? 'l' : '-') + (p.greedy ? 'g' : '-');
            table += `~${flags} ${p.inside} ${sources.get(p.source)}\n`;
        }
    }
});
const patternTable = [...sources.keys()].join('\n') + '\n';
// The raw string's delimiter is ##: its escapes are `\##`, its end `"""##`.
for (const text of [table, patternTable]) {
    if (text.includes('"""##') || text.includes('\\##') || text.includes('\r')) throw new Error('table would break the raw string');
}
const swiftString = (text) => JSON.stringify(text).replace(/\\u([0-9a-f]{4})/g, (_, hex) => `\\u{${hex}}`);

const version = load('prismjs/package.json').version;
const license = fs.readFileSync(path.join(path.resolve(modules), 'prismjs/LICENSE'), 'utf8').trimEnd();
const swift = `// Generated by scripts/generate-prism-grammars.cjs from prismjs ${version}. Do not edit.
//
// The Prism grammars happy-app highlights diffs with, rewritten for ICU.
//
// PrismJS
${license.split('\n').map((line) => (line ? `// ${line}` : '//')).join('\n')}

enum PrismGrammarTable {
    /// Grammar indices by language id.
    static let languages: [String: Int] = [
${languages.map(([name, id]) => `        "${name}": ${id},`).join('\n')}
    ]

    /// Stand-ins in \`patterns\` for long repeated pieces.
    static let macros: [(String, String)] = [
${macros.map(([name, value]) => `        (${swiftString(name)}, ${swiftString(value)}),`).join('\n')}
    ]

    /// Every pattern, one per line, as ICU source.
    static let patterns = ##"""
${patternTable}"""##

    /// \`@index\` starts a grammar, \`=name\` a token, and each
    /// \`~flags inside pattern\` line one of the token's patterns: flags are
    /// \`i\` (ignore case), \`l\` (lookbehind group) and \`g\` (greedy), \`-\`
    /// when off; \`inside\` is a grammar index or -1, and \`pattern\` a line
    /// of \`patterns\`.
    static let grammars = """
${table}"""
}
`;

if (check) {
    const current = fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '';
    if (current !== swift) {
        console.error(`${path.relative(process.cwd(), output)} is stale. Run scripts/generate-prism-grammars.cjs.`);
        process.exit(1);
    }
    console.log(`Prism grammars: ${grammars.length} grammars, up to date`);
} else {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, swift);
    const patterns = grammars.reduce((n, tokens) => n + tokens.reduce((m, t) => m + t.patterns.length, 0), 0);
    console.log(`Prism grammars: ${grammars.length} grammars, ${patterns} patterns (${sources.size} distinct), ${Buffer.byteLength(swift)} bytes`);
}
