import type { PluginLocalizedText } from '@slopus/happy-wire';

import { getCurrentLanguage } from '@/text';

export function resolvePluginText(value: PluginLocalizedText): string {
    const language = getCurrentLanguage();
    return value.translations?.[language]
        ?? value.translations?.[language.split('-')[0]]
        ?? value.default;
}
