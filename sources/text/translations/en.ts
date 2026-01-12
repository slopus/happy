import { en as defaultEn, type TranslationStructure } from '../_default';

/**
 * English translations (temporary re-export).
 *
 * `_default.ts` is currently the canonical source of truth for the English
 * translation structure and is used at runtime by `sources/text/index.ts`.
 *
 * This file exists for the “dedicated translations per language file” migration
 * and for tooling/scripts that import `text/translations/en`.
 *
 * Re-exporting prevents drift and ensures this file always matches
 * `TranslationStructure` without duplicating the full object.
 */
export const en: TranslationStructure = defaultEn;

export type TranslationsEn = typeof en;
