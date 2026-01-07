import { en, type Translations, type TranslationStructure } from './_default';
import { ru } from './translations/ru';
import { pl } from './translations/pl';
import { es } from './translations/es';
import { it } from './translations/it';
import { pt } from './translations/pt';
import { ca } from './translations/ca';
import { zhHans } from './translations/zh-Hans';
import { ja } from './translations/ja';
import * as Localization from 'expo-localization';
import { loadSettings } from '@/sync/persistence';
import { type SupportedLanguage, SUPPORTED_LANGUAGES, SUPPORTED_LANGUAGE_CODES, DEFAULT_LANGUAGE } from './_all';

/**
 * Extract all possible dot-notation keys from the nested translation object
 * E.g., 'common.cancel', 'settings.title', 'time.minutesAgo'
 */
type NestedKeys<T, Path extends string = ''> = T extends object
    ? {
        [K in keyof T]: K extends string
        ? T[K] extends string | ((...args: any[]) => string)
        ? Path extends ''
        ? K
        : `${Path}.${K}`
        : NestedKeys<T[K], Path extends '' ? K : `${Path}.${K}`>
        : never
    }[keyof T]
    : never;

/**
 * Get the value type at a specific dot-notation path
 */
type GetValue<T, Path> = Path extends `${infer Key}.${infer Rest}`
    ? Key extends keyof T
    ? GetValue<T[Key], Rest>
    : never
    : Path extends keyof T
    ? T[Path]
    : never;

/**
 * Extract parameter type from a translation value
 * - If it's a function: extract the first parameter type
 * - If it's a string: return void (no parameters needed)
 */
type GetParams<V> =
    V extends (params: infer P) => string
    ? P
    : V extends string
    ? void
    : never;

/**
 * All valid translation keys
 */
export type TranslationKey = NestedKeys<Translations>;

/**
 * Get the parameter type for a specific translation key
 */
export type TranslationParams<K extends TranslationKey> = GetParams<GetValue<Translations, K>>;

/**
 * Re-export language types and configuration
 */
export type { SupportedLanguage } from './_all';
export { SUPPORTED_LANGUAGES, SUPPORTED_LANGUAGE_CODES, DEFAULT_LANGUAGE, getLanguageNativeName, getLanguageEnglishName } from './_all';

/**
 * Translation objects for all supported languages
 * Each language must match the exact structure of the English translations
 * All languages defined in SUPPORTED_LANGUAGES must be imported and included here
 */
const translations: Record<SupportedLanguage, TranslationStructure> = {
    en,
    ru, // TypeScript will enforce that ru matches the TranslationStructure type exactly
    pl, // TypeScript will enforce that pl matches the TranslationStructure type exactly
    es, // TypeScript will enforce that es matches the TranslationStructure type exactly
    it, // TypeScript will enforce that it matches the TranslationStructure type exactly
    pt, // TypeScript will enforce that pt matches the TranslationStructure type exactly
    ca, // TypeScript will enforce that ca matches the TranslationStructure type exactly
    'zh-Hans': zhHans, // TypeScript will enforce that zh matches the TranslationStructure type exactly
    ja, // TypeScript will enforce that ja matches the TranslationStructure type exactly
};

// Compile-time check: ensure all supported languages have translations
const _typeCheck: Record<SupportedLanguage, TranslationStructure> = translations;

//
// Resolve language
//

let currentLanguage: SupportedLanguage = DEFAULT_LANGUAGE;

// Read from settings
let settings = loadSettings();
let found = false;
if (settings.settings.preferredLanguage && settings.settings.preferredLanguage in translations) {
    currentLanguage = settings.settings.preferredLanguage as SupportedLanguage;
    found = true;
    console.log(`[i18n] Using preferred language: ${currentLanguage}`);
}

// Read from device
if (!found) {
    let locales = Localization.getLocales();
    console.log(`[i18n] Device locales:`, locales.map(l => l.languageCode));
    for (let l of locales) {
        if (l.languageCode) {
            // Expo added special handling for Chinese variants using script code https://github.com/expo/expo/pull/34984
            if (l.languageCode === 'zh') {
                let chineseVariant: string | null = null;
                
                // We only have translations for simplified Chinese right now, but looking for help with traditional Chinese.
                if (l.languageScriptCode === 'Hans') {
                    chineseVariant = 'zh-Hans';
                // } else if (l.languageScriptCode === 'Hant') {
                //     chineseVariant = 'zh-Hant';
                }
                
                console.log(`[i18n] Chinese script code: ${l.languageScriptCode} -> ${chineseVariant}`);
                
                if (chineseVariant && chineseVariant in translations) {
                    currentLanguage = chineseVariant as SupportedLanguage;
                    console.log(`[i18n] Using Chinese variant: ${currentLanguage}`);
                    break;
                }
                
                currentLanguage = 'zh-Hans';
                console.log(`[i18n] Falling back to simplified Chinese: zh-Hans`);
                break;
            }
            
            // Direct match for non-Chinese languages
            if (l.languageCode in translations) {
                currentLanguage = l.languageCode as SupportedLanguage;
                console.log(`[i18n] Using device locale: ${currentLanguage}`);
                break;
            }
        }
    }
}

console.log(`[i18n] Final language: ${currentLanguage}`);

/**
 * Main translation function with strict typing
 * 
 * @param key - Dot-notation key for the translation (e.g., 'common.cancel', 'time.minutesAgo')
 * @param params - Object parameters required by the translation function (if any)
 * @returns Translated string
 * 
 * @example
 * // Simple constants (no parameters)
 * t('common.cancel')                    // "Cancel" or "Отмена"
 * t('settings.title')                   // "Settings" or "Настройки"
 * 
 * // Functions with required object parameters
 * t('common.welcome', { name: 'Steve' })           // "Welcome, Steve!" or "Добро пожаловать, Steve!"
 * t('errors.fieldError', { field: 'Email', reason: 'Invalid' })
 * 
 * // Complex parameters
 * t('sessionInfo.agentState')           // "Agent State" or "Состояние агента"
 */
export function t<K extends TranslationKey>(
    key: K,
    ...args: GetParams<GetValue<Translations, K>> extends void
        ? []
        : [GetParams<GetValue<Translations, K>>]
): string {
    try {
        // Get current language translations
        const currentTranslations = translations[currentLanguage];

        // Navigate to the value using dot notation
        const keys = key.split('.');
        let value: any = currentTranslations;

        for (const k of keys) {
            value = value[k];
            if (value === undefined) {
                console.warn(`Translation missing: ${key}`);
                return key;
            }
        }

        // If it's a function, call it with the provided parameters
        if (typeof value === 'function') {
            const params = args[0];
            return value(params);
        }

        // If it's a string constant, return it directly
        if (typeof value === 'string') {
            return value;
        }

        // Fallback for unexpected types
        console.warn(`Invalid translation value type for key: ${key}`);
        return key;
    } catch (error) {
        console.error(`Translation error for key: ${key}`, error);
        return key;
    }
}

/**
 * Get the currently active language
 * Useful for debugging and language-aware components
 */
export function getCurrentLanguage(): SupportedLanguage {
    return currentLanguage;
}
