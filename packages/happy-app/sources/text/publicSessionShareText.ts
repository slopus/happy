import * as Localization from 'expo-localization';
import { en, type TranslationStructure } from './_default';
import { ca } from './translations/ca';
import { es } from './translations/es';
import { it } from './translations/it';
import { ja } from './translations/ja';
import { pl } from './translations/pl';
import { pt } from './translations/pt';
import { ru } from './translations/ru';
import { zhHans } from './translations/zh-Hans';
import { zhHant } from './translations/zh-Hant';
import type { SupportedLanguage } from './_all';

const publicTranslations: Record<SupportedLanguage, TranslationStructure['sessionShare']> = {
    en: en.sessionShare,
    ru: ru.sessionShare,
    pl: pl.sessionShare,
    es: es.sessionShare,
    it: it.sessionShare,
    pt: pt.sessionShare,
    ca: ca.sessionShare,
    'zh-Hans': zhHans.sessionShare,
    'zh-Hant': zhHant.sessionShare,
    ja: ja.sessionShare,
};

function resolvePublicLanguage(): SupportedLanguage {
    for (const locale of Localization.getLocales()) {
        if (locale.languageCode === 'zh') return locale.languageScriptCode === 'Hant' ? 'zh-Hant' : 'zh-Hans';
        if (locale.languageCode && locale.languageCode in publicTranslations) {
            return locale.languageCode as SupportedLanguage;
        }
    }
    return 'en';
}

const language = resolvePublicLanguage();

export function publicSessionShareText(
    key: `sessionShare.${keyof TranslationStructure['sessionShare'] & string}`,
    params?: Record<string, unknown>,
): string {
    const sessionShareKey = key.slice('sessionShare.'.length) as keyof TranslationStructure['sessionShare'];
    const value = publicTranslations[language][sessionShareKey];
    if (typeof value === 'function') return (value as (input: Record<string, unknown>) => string)(params ?? {});
    return value;
}
