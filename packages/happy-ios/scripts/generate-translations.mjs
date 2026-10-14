#!/usr/bin/env node
// Generates happy-app's ten UI catalogs (packages/happy-app/sources/text) for
// the native app:
//
// - Sources/HappyCore/Localization/TranslationCatalogs.swift: each language
//   as JSON in a raw string, decoded once on first use. A string stays a
//   string. A function becomes a template with `${name}` where it
//   interpolates a parameter; one that picks its words by a number, a
//   boolean or a fixed set of strings becomes the template for each case,
//   with the number's cases following that language's own `plural` helper
//   (`one`/`other`, or `one`/`few`/`many` for Russian and Polish) and any
//   number under 100 it treats on its own (`count === 1`, `count < 5` in
//   Russian) listed exactly.
// - Tests/HappyCoreTests/Fixtures/translation-vectors.json: what every
//   function of every catalog returns for a spread of arguments, which
//   TranslationCatalogTests renders through the Swift catalog and compares.
//
// The catalogs run here as TypeScript, straight from happy-app's sources;
// parameter types are read from _default.ts's annotations, which every
// language must match.
//
// Usage (from the repo root; Node 22.6 or later):
//   node --experimental-strip-types packages/happy-ios/scripts/generate-translations.mjs
//
// Output is deterministic.

import { registerHooks } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const textDir = path.join(repoRoot, 'packages/happy-app/sources/text');
const iosRoot = path.resolve(here, '..');

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
const languages = [
    ['en', '_default.ts', 'en', 'one-other'],
    ['ru', 'translations/ru.ts', 'ru', 'ru'],
    ['pl', 'translations/pl.ts', 'pl', 'pl'],
    ['es', 'translations/es.ts', 'es', 'one-other'],
    ['it', 'translations/it.ts', 'it', 'one-other'],
    ['pt', 'translations/pt.ts', 'pt', 'one-other'],
    ['ca', 'translations/ca.ts', 'ca', 'one-other'],
    ['zh-Hans', 'translations/zh-Hans.ts', 'zhHans', 'one-other'],
    ['zh-Hant', 'translations/zh-Hant.ts', 'zhHant', 'one-other'],
    ['ja', 'translations/ja.ts', 'ja', 'one-other'],
];

// Each file's own `plural` helper, mirrored by TranslationCatalog.PluralRule.
const rules = {
    'one-other': (n) => (n === 1 ? 'one' : 'other'),
    ru: (n) => {
        const a = Math.abs(n), n10 = a % 10, n100 = a % 100;
        if (n10 === 1 && n100 !== 11) return 'one';
        if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return 'few';
        return 'many';
    },
    pl: (n) => {
        const a = Math.abs(n), n10 = a % 10, n100 = a % 100;
        if (a === 1) return 'one';
        if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return 'few';
        return 'many';
    },
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

/// The output with every sentinel turned into `${name}`.
function template(output, names, variant) {
    let text = output;
    for (const name of names) text = text.split(sentinel(name, variant)).join('${' + name + '}');
    if (text.includes('\u{E000}')) throw new Error(`a parameter was transformed, not interpolated: ${output}`);
    return text;
}

/// A function as a template, or a template per case of the one parameter
/// that chooses words.
function compile(fn, key, types) {
    const names = Object.keys(types);
    const textNames = names.filter((n) => kindOf(types[n]) === 'text');
    const call = (fixed, variant) => {
        const args = { ...fixed };
        for (const n of textNames) args[n] = sentinel(n, variant);
        return fn(args);
    };
    const selectors = [];
    // Numbers: a placeholder unless the words change with the value.
    const numberNames = names.filter((n) => kindOf(types[n]) === 'number');
    // Numbers no probe can be part of.
    const neutral = Object.fromEntries(numberNames.map((n, i) => [n, 900_001 + i]));
    const choosers = names.filter((n) => typeof kindOf(types[n]) === 'object' || kindOf(types[n]) === 'bool');
    for (const n of choosers) neutral[n] = typeof kindOf(types[n]) === 'object' ? kindOf(types[n]).values[0] : true;
    // The output with the text parameters and every number but `probed`
    // turned into placeholders, then `probed` itself.
    const numbered = (fixed, probed) => {
        let text = template(call(fixed, 'a'), textNames, 'a');
        for (const n of numberNames) if (n !== probed) text = text.split(String(fixed[n])).join('${' + n + '}');
        return probed ? text.split(String(fixed[probed])).join('${' + probed + '}') : text;
    };
    for (const n of numberNames) {
        const seen = new Set(probes.map((v) => numbered({ ...neutral, [n]: v }, n)));
        if (seen.size > 1) selectors.push(n);
    }
    selectors.push(...choosers);
    if (selectors.length > 1) throw new Error(`${key}: more than one parameter chooses words (${selectors})`);
    const check = (fixed) => {
        // The same template whatever the text parameters say.
        const a = template(call(fixed, 'a'), textNames, 'a');
        const b = template(call(fixed, 'bb'), textNames, 'bb');
        if (a !== b) throw new Error(`${key}: a text parameter changes the words`);
    };
    const render = (fixed) => {
        check(fixed);
        return numbered(fixed, null);
    };
    if (selectors.length === 0) return { t: render(neutral) };
    const selector = selectors[0];
    const kind = kindOf(types[selector]);
    if (kind === 'bool') {
        return { p: selector, k: 'bool', c: { true: render({ ...neutral, [selector]: true }), false: render({ ...neutral, [selector]: false }) } };
    }
    if (typeof kind === 'object') {
        return { p: selector, k: 'enum', c: Object.fromEntries(kind.values.map((v) => [v, render({ ...neutral, [selector]: v })])) };
    }
    return { p: selector, k: 'plural', byValue: (rule) => {
        const perValue = probes.map((v) => {
            const fixed = { ...neutral, [selector]: v };
            check(fixed);
            return numbered(fixed, selector);
        });
        // The most common template of each case, and the values that differ.
        const cases = {};
        for (const category of new Set(probes.map(rule))) {
            const counts = new Map();
            probes.forEach((v, i) => { if (rule(v) === category) counts.set(perValue[i], (counts.get(perValue[i]) ?? 0) + 1); });
            // Ties go to the template of the largest value, which a rule
            // reaches for every number past the probes.
            let best = null;
            for (const [text, count] of counts) if (best === null || count >= best[1]) best = [text, count];
            cases[category] = best[0];
        }
        const exact = {};
        probes.forEach((v, i) => { if (perValue[i] !== cases[rule(v)]) exact[v] = perValue[i]; });
        // Small numbers a catalog spells out on its own (`count === 1`,
        // `count < 5`) are listed; past 100 the rule must hold, so it holds
        // for every number the probes don't reach.
        if (Object.keys(exact).some((v) => Number(v) >= 100)) throw new Error(`${key}: the plural rule doesn't hold past 100`);
        return Object.keys(exact).length ? { c: cases, x: exact } : { c: cases };
    } };
}

/// JavaScript's `${value}` for the vectors.
function sampleArgs(types) {
    const names = Object.keys(types);
    const base = {};
    for (const n of names) {
        const kind = kindOf(types[n]);
        if (kind === 'text') base[n] = `Text ${n} «β»`;
        else if (kind === 'number') base[n] = 42;
        else if (kind === 'bool') base[n] = true;
        else base[n] = kind.values[0];
    }
    const cases = [base];
    for (const n of names) {
        const kind = kindOf(types[n]);
        if (kind === 'number') for (const v of vectorCounts) cases.push({ ...base, [n]: v });
        else if (kind === 'bool') cases.push({ ...base, [n]: false });
        else if (typeof kind === 'object') for (const v of kind.values.slice(1)) cases.push({ ...base, [n]: v });
    }
    return cases;
}

const catalogs = [];
const vectors = {};
let englishKeys = null;
for (const [code, file, exportName, ruleName] of languages) {
    const module = await import(pathToFileURL(path.join(textDir, file)).href);
    const root = module[exportName];
    const entries = {};
    const languageVectors = [];
    const walk = (object, prefix) => {
        for (const [name, value] of Object.entries(object)) {
            const key = prefix ? `${prefix}.${name}` : name;
            if (typeof value === 'string') {
                entries[key] = value;
            } else if (typeof value === 'function') {
                const types = paramTypes.get(name);
                if (!types) throw new Error(`no parameter types for ${key}`);
                const compiled = compile(value, key, types);
                if (compiled.byValue) {
                    const { byValue, ...rest } = compiled;
                    entries[key] = { ...rest, k: ruleName === 'one-other' ? 'plural' : `plural-${ruleName}`, ...byValue(rules[ruleName]) };
                } else {
                    entries[key] = compiled;
                }
                for (const args of sampleArgs(types)) languageVectors.push({ key, args, output: value(args) });
            } else if (value && typeof value === 'object') {
                walk(value, key);
            } else {
                throw new Error(`unexpected ${typeof value} at ${key}`);
            }
        }
    };
    walk(root, '');
    const keys = Object.keys(entries).sort();
    if (englishKeys === null) englishKeys = keys;
    else if (JSON.stringify(keys) !== JSON.stringify(englishKeys)) throw new Error(`${code} does not have English's keys`);
    catalogs.push({ code, rule: ruleName, entries, functions: languageVectors.length ? new Set(languageVectors.map((v) => v.key)).size : 0 });
    vectors[code] = languageVectors;
}

// Swift: one raw string per language.
const sorted = (object) => Object.fromEntries(Object.keys(object).sort().map((k) => [k, object[k]]));
let swift = `// Generated by scripts/generate-translations.mjs from
// packages/happy-app/sources/text. Do not edit.

extension TranslationCatalog {
    /// Every catalog's JSON, by language code, in _all.ts's order.
    static let sources: [(code: String, json: String)] = [
`;
for (const { code, entries } of catalogs) {
    const json = JSON.stringify(sorted(entries));
    if (json.includes('"####')) throw new Error('raw string delimiter in a catalog');
    swift += `        (${JSON.stringify(code)}, ####"${json}"####),\n`;
}
swift += `    ]
}
`;
writeFileSync(path.join(iosRoot, 'Sources/HappyCore/Localization/TranslationCatalogs.swift'), swift);
// One language per line.
const vectorLines = Object.entries(vectors).map(([code, list]) => `${JSON.stringify(code)}:${JSON.stringify(list)}`);
writeFileSync(path.join(iosRoot, 'Tests/HappyCoreTests/Fixtures/translation-vectors.json'), `{\n${vectorLines.join(',\n')}\n}\n`);

for (const { code, entries, functions } of catalogs) {
    const values = Object.values(entries);
    const selected = values.filter((v) => typeof v === 'object' && v.p).length;
    const exact = values.filter((v) => typeof v === 'object' && v.x).length;
    console.log(`${code}: ${values.length} keys, ${functions} functions (${selected} choose words, ${exact} with exact numbers), ${vectors[code].length} vectors`);
}
