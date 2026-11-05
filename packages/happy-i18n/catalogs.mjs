import { readFileSync } from 'node:fs';

export const languages = ['en', 'ru', 'pl', 'es', 'it', 'pt', 'ca', 'zh-Hans', 'zh-Hant', 'ja'];
export const parameters = JSON.parse(readFileSync(new URL('./translations/parameters.json', import.meta.url), 'utf8'));

export function readCatalog(code) {
    if (!languages.includes(code)) throw new Error(`Unknown language: ${code}`);
    return JSON.parse(readFileSync(new URL(`./translations/${code}.json`, import.meta.url), 'utf8'));
}

function pluralCategory(kind, value) {
    const n = Math.abs(value), n10 = n % 10, n100 = n % 100;
    if (kind === 'plural-ru') {
        if (n10 === 1 && n100 !== 11) return 'one';
        if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return 'few';
        return 'many';
    }
    if (kind === 'plural-pl') {
        if (n === 1) return 'one';
        if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return 'few';
        return 'many';
    }
    return value === 1 ? 'one' : 'other';
}

export function render(entry, args) {
    if (typeof entry === 'string') return entry;
    let template = entry.t;
    if (entry.p) {
        const value = args[entry.p];
        const category = entry.k.startsWith('plural') ? pluralCategory(entry.k, value) : String(value);
        template = entry.x?.[String(value)] ?? entry.c[category];
    }
    if (typeof template !== 'string') throw new Error('Missing translation case');
    return template.replace(/\$\{([^}]+)\}/g, (_, name) => {
        if (!(name in args)) throw new Error(`Missing translation argument: ${name}`);
        return String(args[name]);
    });
}