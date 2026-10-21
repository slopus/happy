// Generates the app's string resources from happy-app's ten UI catalogs
// (packages/happy-app/sources/text), so the Kotlin app says what the React
// Native one says in every language:
//
// - app/src/main/res/values{,-<qualifier>}/strings.xml: one per language.
// - app/src/main/kotlin/com/slopus/happy/text/PluralExactNumbers.kt: the
//   numbers some catalog spells out (below).
// - app/src/test/resources/translation-vectors.json: every key's resource,
//   English's strings, and what every function of every catalog returns for
//   a spread of arguments, which TranslationResourcesTest renders through
//   the resources and compares.
//
// Names: the key path, camelCase to snake_case and dots to `_`
// (`settings.whatsNewSubtitle` -> `settings_whats_new_subtitle`). Where two
// keys come out alike, the later one keeps its dots as `__`.
//
// Values:
// - A string stays a `<string>`.
// - A function becomes a format string. Its parameters are numbered in the
//   order _default.ts's annotation lists them: text as `%n$s`, numbers as
//   `%n$d`.
// - A function that picks its words by a number (in any language) becomes
//   `<plurals>` with the categories Android's plural rules give each
//   language (one/other in English, one/few/many/other in Russian and
//   Polish, other alone in Japanese and Chinese). Each category holds the
//   words happy-app's function returns for the numbers in it. A number whose
//   words its category doesn't give (Japanese `count === 1`, which Android
//   files under `other`; Portuguese 0, which Android files under `one`) gets
//   its own string, `<name>_n<number>`, in every language;
//   `Resources.plural` (text/Translations.kt) prefers it.
// - A function that picks its words by a boolean or a fixed set of strings
//   becomes one `<string>` per case: `<name>_true` / `<name>_false`, or
//   `<name>_<value>` (`settings.machineStatus` -> `settings_machine_status_online`,
//   `settings_machine_status_offline`). The other parameters keep their
//   numbers.
//
// The catalogs run here as TypeScript, straight from happy-app's sources;
// parameter types are read from _default.ts's annotations, which every
// language must match.
//
// Usage (Node 22.18 or later):
//   cd packages/happy-android/tools/translations && npm run generate
//
// Output is deterministic.

import { registerHooks } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const androidRoot = path.resolve(here, '../..');
const textDir = path.resolve(androidRoot, '../happy-app/sources/text');
const resDir = path.join(androidRoot, 'app/src/main/res');
const vectorsFile = path.join(androidRoot, 'app/src/test/resources/translation-vectors.json');
const kotlinFile = path.join(androidRoot, 'app/src/main/kotlin/com/slopus/happy/text/PluralExactNumbers.kt');

registerHooks({
    resolve(specifier, context, next) {
        // The translations import `../_default` without an extension.
        if (/(^|\/)_default$/.test(specifier)) {
            return { url: pathToFileURL(path.join(textDir, '_default.ts')).href, shortCircuit: true };
        }
        return next(specifier, context);
    },
});

// _all.ts's order; index.ts's catalogs (`en` is _default.ts's).
// [code, file, export, resource directory, Android plural rule]
const languages = [
    ['en', '_default.ts', 'en', 'values', 'en'],
    ['ru', 'translations/ru.ts', 'ru', 'values-ru', 'ru'],
    ['pl', 'translations/pl.ts', 'pl', 'values-pl', 'pl'],
    ['es', 'translations/es.ts', 'es', 'values-es', 'romance'],
    ['it', 'translations/it.ts', 'it', 'values-it', 'romance'],
    ['pt', 'translations/pt.ts', 'pt', 'values-pt', 'pt'],
    ['ca', 'translations/ca.ts', 'ca', 'values-ca', 'romance'],
    ['zh-Hans', 'translations/zh-Hans.ts', 'zhHans', 'values-b+zh+Hans', 'none'],
    ['zh-Hant', 'translations/zh-Hant.ts', 'zhHant', 'values-b+zh+Hant', 'none'],
    ['ja', 'translations/ja.ts', 'ja', 'values-ja', 'none'],
];

// Android's (CLDR's) plural rules for integers, by the categories each
// language has. `many` in the Romance languages is for exact millions.
const rules = {
    en: { categories: ['one', 'other'], select: (n) => (n === 1 ? 'one' : 'other') },
    romance: {
        categories: ['one', 'many', 'other'],
        select: (n) => (n === 1 ? 'one' : n !== 0 && n % 1_000_000 === 0 ? 'many' : 'other'),
    },
    pt: {
        // Brazilian Portuguese, which values-pt serves: 0 and 1 are `one`.
        categories: ['one', 'many', 'other'],
        select: (n) => (n === 0 || n === 1 ? 'one' : n % 1_000_000 === 0 ? 'many' : 'other'),
    },
    ru: {
        categories: ['one', 'few', 'many', 'other'],
        select: (n) => {
            const n10 = n % 10, n100 = n % 100;
            if (n10 === 1 && n100 !== 11) return 'one';
            if (n10 >= 2 && n10 <= 4 && !(n100 >= 12 && n100 <= 14)) return 'few';
            return 'many';
        },
    },
    pl: {
        categories: ['one', 'few', 'many', 'other'],
        select: (n) => {
            const n10 = n % 10, n100 = n % 100;
            if (n === 1) return 'one';
            if (n10 >= 2 && n10 <= 4 && !(n100 >= 12 && n100 <= 14)) return 'few';
            return 'many';
        },
    },
    none: { categories: ['other'], select: () => 'other' },
};

// Parameter types, from _default.ts: `key: ({ a, b }: { a: string; b: number }) =>`.
const source = readFileSync(path.join(textDir, '_default.ts'), 'utf8');
const paramTypes = new Map();
for (const match of source.matchAll(/(\w+):\s*\(\{([^}]*)\}\s*:\s*\{([^}]*)\}\s*\)\s*=>/g)) {
    const [, leaf, , annotation] = match;
    const types = {};
    for (const part of annotation.split(';').map((s) => s.trim()).filter(Boolean)) {
        const [name, type] = part.split(':').map((s) => s.trim());
        types[name.replace('?', '')] = type;
    }
    const known = paramTypes.get(leaf);
    if (known && JSON.stringify(known) !== JSON.stringify(types)) throw new Error(`conflicting types for ${leaf}`);
    paramTypes.set(leaf, types);
}

const probes = Array.from({ length: 1001 }, (_, i) => i);
const vectorCounts = [0, 1, 2, 3, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111, 112, 1000, 1001, 1002];
const sentinel = (name, variant) => `\u{E000}${variant}${name}\u{E001}`;

function kindOf(type) {
    if (type === 'number') return 'number';
    if (type === 'boolean') return 'bool';
    if (type === 'string' || type === 'number | string') return 'text';
    const literals = [...type.matchAll(/'([^']*)'/g)].map((m) => m[1]);
    if (literals.length > 0 && type.replace(/'[^']*'|\|/g, '').trim() === '') return { values: literals };
    throw new Error(`unsupported parameter type ${type}`);
}

const snake = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').replace(/-/g, '_').toLowerCase();
const resourceName = (key) => key.split('.').map(snake).join('_');

/// The parameter that chooses a function's words, if any, and `build(p)`,
/// which compiles it to templates in which `\u{E002}name\u{E003}` marks
/// where a parameter goes: `{ t }`, `{ p, cases: { value: t } }` for a
/// boolean or enum chooser, or `{ p, plural: [template per probe] }`.
function compile(fn, key, types) {
    const names = Object.keys(types);
    const textNames = names.filter((n) => kindOf(types[n]) === 'text');
    const numberNames = names.filter((n) => kindOf(types[n]) === 'number');
    const choosers = names.filter((n) => typeof kindOf(types[n]) === 'object' || kindOf(types[n]) === 'bool');
    const mark = (n) => `\u{E002}${n}\u{E003}`;
    const call = (fixed, variant) => {
        const args = { ...fixed };
        for (const n of textNames) args[n] = sentinel(n, variant);
        let text = fn(args);
        for (const n of textNames) text = text.split(sentinel(n, variant)).join(mark(n));
        if (text.includes('\u{E000}')) throw new Error(`${key}: a parameter was transformed, not interpolated`);
        return text;
    };
    // Numbers no probe can be part of.
    const neutral = Object.fromEntries(numberNames.map((n, i) => [n, 900_001 + i]));
    for (const n of choosers) neutral[n] = typeof kindOf(types[n]) === 'object' ? kindOf(types[n]).values[0] : true;
    // The output with every number but `probed` marked, then `probed` too.
    const numbered = (fixed, probed) => {
        const a = call(fixed, 'a');
        if (a !== call(fixed, 'bb')) throw new Error(`${key}: a text parameter changes the words`);
        if (probed === '') return a;
        let text = a;
        for (const n of numberNames) if (n !== probed) text = text.split(String(fixed[n])).join(mark(n));
        return probed ? text.split(String(fixed[probed])).join(mark(probed)) : text;
    };
    // A number chooses words when one template with it filled in doesn't
    // say what the function says for every probe.
    const base = numbered(neutral, null);
    const fillAll = (template, fixed) => numberNames.reduce((t, n) => t.split(mark(n)).join(String(fixed[n])), template);
    const selectors = numberNames.filter((n) => probes.some((v) => {
        const fixed = { ...neutral, [n]: v };
        return fillAll(base, fixed) !== numbered(fixed, '');
    }));
    selectors.push(...choosers);
    if (selectors.length > 1) throw new Error(`${key}: more than one parameter chooses words (${selectors})`);
    const build = (p) => {
        if (p === null) return { t: base };
        const kind = kindOf(types[p]);
        if (kind === 'bool') {
            return { p, cases: { true: numbered({ ...neutral, [p]: true }, null), false: numbered({ ...neutral, [p]: false }, null) } };
        }
        if (typeof kind === 'object') {
            return { p, cases: Object.fromEntries(kind.values.map((v) => [v, numbered({ ...neutral, [p]: v }, null)])) };
        }
        return { p, plural: probes.map((v) => numbered({ ...neutral, [p]: v }, p)) };
    };
    return { selector: selectors[0] ?? null, build };
}

/// Templates per category of `rule`, and the probes whose words differ
/// from their category's.
function pluralCases(key, p, perValue, rule) {
    const fill = (template, v) => template.split(`\u{E002}${p}\u{E003}`).join(String(v));
    const cases = {};
    for (const category of rule.categories) {
        const counts = new Map();
        probes.forEach((v, i) => { if (rule.select(v) === category) counts.set(perValue[i], (counts.get(perValue[i]) ?? 0) + 1); });
        // Ties go to the template of the largest value, which a rule
        // reaches for every number past the probes.
        let best = null;
        for (const [text, count] of counts) if (best === null || count >= best[1]) best = [text, count];
        cases[category] = best?.[0];
    }
    // A category no probe reaches (`many` for millions, `other` for
    // fractions in Russian and Polish) takes the words of the largest
    // numbers.
    const fallback = perValue[perValue.length - 1];
    for (const category of rule.categories) cases[category] ??= category === 'other' && cases.many ? cases.many : fallback;
    // A number is exact when its category's words, with it filled in, are
    // not what the function says. Its own string spells the number out.
    const exact = {};
    probes.forEach((v, i) => {
        const said = fill(perValue[i], v);
        if (fill(cases[rule.select(v)], v) !== said) exact[v] = said;
    });
    if (Object.keys(exact).some((v) => Number(v) >= 100)) throw new Error(`${key}: the plural rule doesn't hold past 100`);
    return { categories: cases, exact, said: (v) => fill(perValue[v], v) };
}

/// Android's escaping of a template; `format` when it is a format string.
function escape(template, positions, format) {
    const tokens = template.split(/(\u{E002}[^\u{E003}]*\u{E003})/u);
    const whole = tokens.map((t) => (t.startsWith('\u{E002}') ? '\u{E002}' : t)).join('');
    let out = '';
    let at = 0;
    for (const token of tokens) {
        if (token.startsWith('\u{E002}')) {
            const name = token.slice(1, -1);
            const position = positions.get(name);
            if (!position) throw new Error(`no position for ${name}`);
            out += `%${position.index}$${position.conversion}`;
            at++;
            continue;
        }
        for (const c of token) {
            if (c === '\\') out += '\\\\';
            else if (c === "'") out += "\\'";
            else if (c === '"') out += '\\"';
            else if (c === '\n') out += '\\n';
            else if (c === '\t') out += '\\t';
            else if (c === '&') out += '&amp;';
            else if (c === '<') out += '&lt;';
            else if (c === '>') out += '&gt;';
            else if (c === '%' && format) out += '%%';
            // Invisible characters (no-break spaces, joiners) stay visible here.
            else if (c !== ' ' && /[\p{Z}\p{C}]/u.test(c)) out += `\\u${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
            // aapt trims the ends and collapses runs of white space.
            else if (c === ' ' && (at === 0 || at === whole.length - 1 || whole[at + 1] === ' ' || whole[at - 1] === ' ')) out += '\\u0020';
            else out += c;
            at += c.length;
        }
    }
    // A leading @ or ? would make the value a reference.
    if (out.startsWith('@') || out.startsWith('?')) out = '\\' + out;
    return out;
}

/// Format positions: every parameter but a boolean or enum chooser, in the
/// annotation's order.
function positionsOf(types) {
    const positions = new Map();
    let index = 1;
    for (const [name, type] of Object.entries(types)) {
        const kind = kindOf(type);
        if (kind === 'bool' || typeof kind === 'object') continue;
        positions.set(name, { index: index++, conversion: kind === 'number' ? 'd' : 's' });
    }
    return positions;
}

/// JavaScript's arguments for the vectors: every count that tells plural
/// categories apart for the number that chooses words, one more value for
/// any other number, every case of a boolean or enum.
function sampleArgs(types, p) {
    const names = Object.keys(types);
    const base = {};
    for (const n of names) {
        const kind = kindOf(types[n]);
        if (kind === 'text') base[n] = `Text ${n} «β» 100%`;
        else if (kind === 'number') base[n] = 42;
        else if (kind === 'bool') base[n] = true;
        else base[n] = kind.values[0];
    }
    const cases = [base];
    for (const n of names) {
        const kind = kindOf(types[n]);
        if (kind === 'number') for (const v of n === p ? vectorCounts : [7]) cases.push({ ...base, [n]: v });
        else if (kind === 'bool') cases.push({ ...base, [n]: false });
        else if (typeof kind === 'object') for (const v of kind.values.slice(1)) cases.push({ ...base, [n]: v });
    }
    return cases;
}

// Pass 1: every catalog compiled, keyed by key path in _default.ts's order.
const compiled = [];
for (const [code, file, exportName, dir, ruleName] of languages) {
    const module = await import(pathToFileURL(path.join(textDir, file)).href);
    const rule = rules[ruleName];
    const entries = new Map();
    const vectors = [];
    const walk = (object, prefix) => {
        for (const [leaf, value] of Object.entries(object)) {
            const key = prefix ? `${prefix}.${leaf}` : leaf;
            if (value && typeof value === 'object') {
                walk(value, key);
            } else if (typeof value === 'string') {
                entries.set(key, { s: value });
            } else if (typeof value === 'function') {
                const types = paramTypes.get(leaf);
                if (!types) throw new Error(`no parameter types for ${key}`);
                entries.set(key, { types, fn: value, ...compile(value, key, types) });
            } else {
                throw new Error(`unexpected ${typeof value} at ${key}`);
            }
        }
    };
    walk(module[exportName], '');
    compiled.push({ code, file, dir, rule, entries, vectors });
}

// A key whose words some language chooses by a parameter is chosen by it in
// every language (English's `multipleQuestions` says "questions" for any
// count; Portuguese's doesn't), so the resource has one shape.
for (const key of compiled[0].entries.keys()) {
    const chosen = new Set(compiled.map(({ entries }) => entries.get(key)?.selector).filter((p) => p != null));
    if (chosen.size > 1) throw new Error(`${key}: languages choose words by different parameters (${[...chosen]})`);
    const p = chosen.size ? [...chosen][0] : null;
    for (const { entries, rule } of compiled) {
        const entry = entries.get(key);
        if (!entry || !entry.build) continue;
        const built = entry.build(p);
        delete entry.build;
        delete entry.selector;
        Object.assign(entry, built);
        if (entry.plural) Object.assign(entry, pluralCases(key, entry.p, entry.plural, rule));
    }
}
for (const { entries, vectors } of compiled) {
    for (const [key, entry] of [...compiled[0].entries.keys()].map((k) => [k, entries.get(k)])) {
        if (entry.fn) for (const args of sampleArgs(entry.types, entry.p)) vectors.push({ key, args, output: entry.fn(args) });
    }
}

// Names, from English's keys. Two keys that snake-case alike
// (`settingsVoice.languageTitle`, `settingsVoice.language.title`): the
// later one keeps its dots as `__`.
const english = compiled[0];
const names = new Map();
const taken = new Set();
const claim = (name, key) => {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`${key}: invalid resource name ${name}`);
    if (taken.has(name)) throw new Error(`${key}: ${name} is taken`);
    taken.add(name);
};
for (const [key, entry] of english.entries) {
    let name = resourceName(key);
    if (taken.has(name)) name = key.split('.').map(snake).join('__');
    if (entry.cases) for (const c of Object.keys(entry.cases)) claim(`${name}_${snake(c)}`, key);
    else claim(name, key);
    names.set(key, name);
}
for (const { code, entries } of compiled) {
    const keys = [...entries.keys()];
    if (JSON.stringify(keys.slice().sort()) !== JSON.stringify([...names.keys()].sort())) throw new Error(`${code} does not have English's keys`);
}

// Numbers any catalog spells out get their own string in every language,
// so a language never falls back to English's.
const exactNumbers = new Map();
for (const { entries } of compiled) {
    for (const [key, entry] of entries) {
        if (!entry.plural) continue;
        const set = exactNumbers.get(key) ?? new Set();
        for (const n of Object.keys(entry.exact)) set.add(Number(n));
        exactNumbers.set(key, set);
    }
}
for (const [key, set] of exactNumbers) for (const n of set) claim(`${names.get(key)}_n${n}`, key);

// Pass 2: the resources. ImpliedQuantity is ignored because a number a catalog
// spells out (Portuguese `count === 1`, whose "one" also covers 0) gets its own
// `_n<number>` string, which Resources.plural picks before the quantity.
const header = (code, file) => `<?xml version="1.0" encoding="utf-8"?>
<!--
  Generated by tools/translations/generate.mjs from
  packages/happy-app/sources/text/${file} (${code}). Do not edit.
-->
<resources xmlns:tools="http://schemas.android.com/tools" tools:ignore="MissingTranslation,UnusedQuantity,UnusedResources,Typos,PluralsCandidate,StringFormatCount,ImpliedQuantity">
`;
const summary = [];
for (const { code, file, dir, rule, entries, vectors } of compiled) {
    const lines = [];
    let group = null;
    let count = 0;
    // English's order in every language, so the files diff line by line.
    for (const key of names.keys()) {
        const entry = entries.get(key);
        const top = key.split('.')[0];
        if (group !== null && top !== group) lines.push('');
        group = top;
        const name = names.get(key);
        const string = (n, text, positions, format) => {
            count++;
            const formatted = !format && text.includes('%') ? ' formatted="false"' : '';
            lines.push(`    <string name="${n}"${formatted}>${escape(text, positions, format)}</string>`);
        };
        if (entry.s !== undefined) {
            string(name, entry.s, new Map(), false);
            continue;
        }
        const positions = positionsOf(entry.types);
        if (entry.t !== undefined) {
            string(name, entry.t, positions, true);
        } else if (entry.cases) {
            for (const [c, t] of Object.entries(entry.cases)) string(`${name}_${snake(c)}`, t, positions, true);
        } else {
            count++;
            lines.push(`    <plurals name="${name}">`);
            for (const category of rule.categories) lines.push(`        <item quantity="${category}">${escape(entry.categories[category], positions, true)}</item>`);
            lines.push('    </plurals>');
            for (const n of [...exactNumbers.get(key)].sort((a, b) => a - b)) string(`${name}_n${n}`, entry.said(n), positions, true);
        }
    }
    mkdirSync(path.join(resDir, dir), { recursive: true });
    writeFileSync(path.join(resDir, dir, 'strings.xml'), header(code, file) + lines.join('\n') + '\n</resources>\n');
    summary.push(`${code}: ${entries.size} keys, ${count} resources, ${vectors.length} vectors`);
}

// The plurals whose numbers have their own strings, for Translations.plural.
let kotlin = `// Generated by tools/translations/generate.mjs. Do not edit.

package com.slopus.happy.text

import com.slopus.happy.R

/** Plurals whose catalogs spell out some numbers: plural id to (number to string id). */
internal val pluralExactNumbers: Map<Int, Map<Int, Int>> = mapOf(
`;
for (const [key, set] of exactNumbers) {
    if (set.size === 0) continue;
    const name = names.get(key);
    const pairs = [...set].sort((a, b) => a - b).map((n) => `${n} to R.string.${name}_n${n}`).join(', ');
    kotlin += `    R.plurals.${name} to mapOf(${pairs}),\n`;
}
kotlin += ')\n';
mkdirSync(path.dirname(kotlinFile), { recursive: true });
writeFileSync(kotlinFile, kotlin);

// Every key's resource and how a function's arguments reach it, English's
// strings, then each language's function vectors, one per line.
const keys = {};
for (const [key, entry] of english.entries) {
    const name = names.get(key);
    if (entry.s !== undefined) keys[key] = { name, kind: 'string', value: entry.s };
    else keys[key] = {
        name,
        kind: entry.plural ? 'plural' : entry.cases ? 'cases' : 'format',
        p: entry.p,
        params: [...positionsOf(entry.types).keys()],
        cases: entry.cases && Object.fromEntries(Object.keys(entry.cases).map((c) => [c, `${name}_${snake(c)}`])),
    };
}
mkdirSync(path.dirname(vectorsFile), { recursive: true });
const keyLines = Object.entries(keys).map(([key, info]) => `${JSON.stringify(key)}:${JSON.stringify(info)}`);
const vectorLines = compiled.map(({ code, vectors }) => `${JSON.stringify(code)}:${JSON.stringify(vectors)}`);
// The catalogs' SHA-256, so the test notices when they change.
const sources = Object.fromEntries(languages.map(([, file]) => [file, createHash('sha256').update(readFileSync(path.join(textDir, file))).digest('hex')]));
writeFileSync(vectorsFile, `{"sources":${JSON.stringify(sources)},\n"keys":{\n${keyLines.join(',\n')}\n},\n"vectors":{\n${vectorLines.join(',\n')}\n}}\n`);
for (const line of summary) console.log(line);
