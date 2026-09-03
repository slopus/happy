import { describe, expect, it } from 'vitest';
import { ca } from './translations/ca';
import { en } from './translations/en';
import { es } from './translations/es';
import { it as italian } from './translations/it';
import { ja } from './translations/ja';
import { pl } from './translations/pl';
import { pt } from './translations/pt';
import { ru } from './translations/ru';
import { zhHans } from './translations/zh-Hans';
import { zhHant } from './translations/zh-Hant';

describe('MCP App translation shape', () => {
    it('provides non-empty state and link-confirmation copy in every supported locale', () => {
        const translations = { en, 'zh-Hans': zhHans, 'zh-Hant': zhHant, ja, ca, es, it: italian, pl, pt, ru };
        const keys = [
            'loading', 'offline', 'retry', 'unsupported', 'unavailable',
            'openLinkTitle', 'openLinkMessage', 'openLinkConfirm', 'openLinkCancel',
        ] as const;

        for (const [locale, translation] of Object.entries(translations)) {
            for (const key of keys) {
                expect(translation.mcpApps[key], `${locale}.${key}`).toEqual(expect.any(String));
                expect(translation.mcpApps[key].trim(), `${locale}.${key}`).not.toBe('');
            }
        }
    });
});
