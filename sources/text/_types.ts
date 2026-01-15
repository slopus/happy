import { en } from './translations/en';

export type Translations = typeof en;

/**
 * Generic translation type that matches the structure of Translations
 * but allows different string values (for other languages).
 */
export type TranslationStructure = {
    readonly [K in keyof Translations]: {
        readonly [P in keyof Translations[K]]: Translations[K][P] extends string
            ? string
            : Translations[K][P] extends (...args: any[]) => string
                ? Translations[K][P]
                : Translations[K][P] extends object
                    ? {
                        readonly [Q in keyof Translations[K][P]]: Translations[K][P][Q] extends string
                            ? string
                            : Translations[K][P][Q]
                      }
                    : Translations[K][P]
    }
};

