#!/usr/bin/env tsx

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import all translation files
import { en } from '../text/translations/en';
import { ru } from '../text/translations/ru';
import { pl } from '../text/translations/pl';
import { es } from '../text/translations/es';
import { pt } from '../text/translations/pt';
import { ca } from '../text/translations/ca';
import { zhHans } from '../text/translations/zh-Hans';

const translations = {
    en,
    ru,
    pl,
    es,
    pt,
    ca,
    'zh-Hans': zhHans,
};

const languageNames: Record<string, string> = {
    en: 'English',
    ru: 'Russian',
    pl: 'Polish',
    es: 'Spanish',
    pt: 'Portuguese',
    ca: 'Catalan',
    'zh-Hans': 'Chinese (Simplified)',
};

// Function to recursively extract all keys from an object
function extractKeys(obj: any, prefix = ''): Set<string> {
    const keys = new Set<string>();

    for (const key in obj) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        const value = obj[key];

        if (typeof value === 'function') {
            keys.add(fullKey);
        } else if (typeof value === 'string') {
            keys.add(fullKey);
        } else if (typeof value === 'object' && value !== null) {
            const subKeys = extractKeys(value, fullKey);
            subKeys.forEach(k => keys.add(k));
        }
    }

    return keys;
}

// Function to check if a value is still in English (for non-English translations)
function checkIfEnglish(path: string, value: any, englishValue: any, lang: string): boolean {
    if (lang === 'en') return false;

    // For functions, we can't easily compare
    if (typeof value === 'function' && typeof englishValue === 'function') {
        return false; // Skip function comparison
    }

    // For strings, check if they're identical to English
    if (typeof value === 'string' && typeof englishValue === 'string') {
        // Some technical terms should remain in English
        const technicalTerms = ['GitHub', 'URL', 'API', 'CLI', 'OAuth', 'QR', 'JSON', 'HTTP', 'HTTPS', 'ID', 'PID'];
        for (const term of technicalTerms) {
            if (value === term || englishValue === term) {
                return false; // It's ok for technical terms to be the same
            }
        }

        // Check if the non-English translation is identical to English
        return value === englishValue && value.length > 3; // Ignore short strings like "OK"
    }

    return false;
}

// Function to get nested value
function getNestedValue(obj: any, path: string): any {
    const keys = path.split('.');
    let current = obj;

    for (const key of keys) {
        if (current && typeof current === 'object' && key in current) {
            current = current[key];
        } else {
            return undefined;
        }
    }

    return current;
}

console.log('# Translation Completeness Report\n');
console.log('## Summary of Languages\n');

// Get all keys from English (reference)
const englishKeys = extractKeys(translations.en);
console.log(`**English (reference)**: ${englishKeys.size} keys\n`);

// Track all issues
const missingKeys: Record<string, string[]> = {};
const untranslatedStrings: Record<string, string[]> = {};

// Compare each language with English
for (const [langCode, translation] of Object.entries(translations)) {
    if (langCode === 'en') continue;

    const langKeys = extractKeys(translation);
    const missing: string[] = [];
    const untranslated: string[] = [];

    // Find missing keys
    for (const key of englishKeys) {
        if (!langKeys.has(key)) {
            missing.push(key);
        } else {
            // Check if the value is still in English
            const value = getNestedValue(translation, key);
            const englishValue = getNestedValue(translations.en, key);
            if (checkIfEnglish(key, value, englishValue, langCode)) {
                untranslated.push(`${key}: "${value}"`);
            }
        }
    }

    // Find extra keys (that don't exist in English)
    const extra: string[] = [];
    for (const key of langKeys) {
        if (!englishKeys.has(key)) {
            extra.push(key);
        }
    }

    if (missing.length > 0) {
        missingKeys[langCode] = missing;
    }
    if (untranslated.length > 0) {
        untranslatedStrings[langCode] = untranslated;
    }

    console.log(`**${languageNames[langCode]}** (${langCode}): ${langKeys.size} keys`);
    if (missing.length > 0) {
        console.log(`  - ❌ Missing: ${missing.length} keys`);
    }
    if (untranslated.length > 0) {
        console.log(`  - ⚠️ Untranslated: ${untranslated.length} strings`);
    }
    if (extra.length > 0) {
        console.log(`  - ➕ Extra: ${extra.length} keys`);
    }
    if (missing.length === 0 && untranslated.length === 0 && extra.length === 0) {
        console.log(`  - ✅ Complete and consistent`);
    }
    console.log('');
}

// Detailed report of issues
if (Object.keys(missingKeys).length > 0 || Object.keys(untranslatedStrings).length > 0) {
    console.log('\n## Detailed Issues\n');

    // Report missing keys
    if (Object.keys(missingKeys).length > 0) {
        console.log('### Missing Translation Keys\n');
        for (const [langCode, missing] of Object.entries(missingKeys)) {
            console.log(`#### ${languageNames[langCode]} (${langCode})\n`);
            console.log('Missing the following keys:');
            for (const key of missing) {
                const englishValue = getNestedValue(translations.en, key);
                if (typeof englishValue === 'function') {
                    console.log(`- \`${key}\` (function)`);
                } else {
                    console.log(`- \`${key}\`: "${englishValue}"`);
                }
            }
            console.log('');
        }
    }

    // Report untranslated strings
    if (Object.keys(untranslatedStrings).length > 0) {
        console.log('### Untranslated Strings (Still in English)\n');
        for (const [langCode, untranslated] of Object.entries(untranslatedStrings)) {
            console.log(`#### ${languageNames[langCode]} (${langCode})\n`);
            console.log('The following strings appear to be untranslated:');
            for (const item of untranslated) {
                console.log(`- ${item}`);
            }
            console.log('');
        }
    }
} else {
    console.log('\n## ✅ All Translations Complete!\n');
    console.log('All language files have complete translations with no missing keys or untranslated strings.');
}

// Sample a few translations to verify content
console.log('\n## Sample Translation Verification\n');
const sampleKeys = ['common.cancel', 'settings.title', 'errors.networkError', 'common.save'];

for (const key of sampleKeys) {
    console.log(`### Key: \`${key}\`\n`);
    for (const [langCode, translation] of Object.entries(translations)) {
        const value = getNestedValue(translation, key);
        console.log(`- **${languageNames[langCode]}**: ${typeof value === 'string' ? `"${value}"` : '(function)'}`);
    }
    console.log('');
}