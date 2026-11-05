import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { languages, parameters, readCatalog, render } from './catalogs.mjs';

test('all locales have the same keys and declared template parameters', () => {
    const keys = Object.keys(readCatalog('en').entries).sort();
    assert.equal(keys.length, 909);
    for (const code of languages) {
        const catalog = readCatalog(code);
        assert.equal(catalog.code, code);
        assert.deepEqual(Object.keys(catalog.entries).sort(), keys);
        for (const [key, entry] of Object.entries(catalog.entries)) {
            if (typeof entry === 'string') continue;
            const types = parameters[key.split('.').at(-1)];
            assert.ok(types, `${code}: ${key}`);
            const templates = entry.t !== undefined ? [entry.t] : [...Object.values(entry.c), ...Object.values(entry.x ?? {})];
            if (entry.p) assert.ok(entry.p in types, `${key}: selector`);
            for (const template of templates) {
                assert.equal(typeof template, 'string');
                for (const [, name] of template.matchAll(/\$\{([^}]+)\}/g)) {
                    assert.ok(name in types, `${key}: ${name}`);
                }
            }
        }
    }
});

test('all native function vectors match JSON rendering', () => {
    const ios = JSON.parse(readFileSync(new URL('../happy-ios/Tests/HappyCoreTests/Fixtures/translation-vectors.json', import.meta.url), 'utf8'));
    const android = JSON.parse(readFileSync(new URL('../happy-android/app/src/test/resources/translation-vectors.json', import.meta.url), 'utf8')).vectors;
    for (const code of languages) {
        const { entries } = readCatalog(code);
        for (const vector of [...ios[code], ...android[code]]) {
            assert.equal(render(entries[vector.key], vector.args), vector.output, `${code}: ${vector.key}`);
        }
    }
});

test('plural categories, exact counts, choices and interpolation', () => {
    const russian = { p: 'count', k: 'plural-ru', c: { one: '${count} one', few: '${count} few', many: '${count} many' }, x: { 0: 'none' } };
    for (const [count, expected] of [[0, 'none'], [1, '1 one'], [2, '2 few'], [11, '11 many'], [21, '21 one'], [102, '102 few'], [-2, '-2 few']]) {
        assert.equal(render(russian, { count }), expected);
    }
    const polish = { ...russian, k: 'plural-pl' };
    assert.equal(render(polish, { count: 21 }), '21 many');
    assert.equal(render(polish, { count: 22 }), '22 few');
    const choice = { p: 'enabled', k: 'bool', c: { true: '${name} on', false: '${name} off' } };
    assert.equal(render(choice, { enabled: false, name: '${count} 100% <β>' }), '${count} 100% <β> off');
    assert.throws(() => render({ t: '${missing}' }, {}), /Missing translation argument/);
});