// ElevenLabs supported language codes
export type ElevenLabsLanguage = "en" | "ja" | "zh" | "de" | "hi" | "fr" | "ko" | 
    "pt" | "pt-br" | "it" | "es" | "id" | "nl" | "tr" | "pl" | "sv" | "bg" | 
    "ro" | "ar" | "cs" | "el" | "fi" | "ms" | "da" | "ta" | "uk" | "ru" | 
    "hu" | "hr" | "sk" | "no" | "vi";

// Language type definition
export interface Language {
    code: string | null; // null for autodetect
    name: string;
    nativeName: string;
    region?: string;
    elevenLabsCode?: ElevenLabsLanguage; // ElevenLabs language code mapping
}

// Comprehensive language list with locale codes, names, and regions
// First option is autodetect (null value)
export const LANGUAGES: Language[] = [
    { code: null, name: 'Auto-detect', nativeName: 'Auto-detect' },
    { code: 'en-US', name: 'English', nativeName: 'English', region: 'United States', elevenLabsCode: 'en' },
    { code: 'en-GB', name: 'English', nativeName: 'English', region: 'United Kingdom', elevenLabsCode: 'en' },
    { code: 'en-AU', name: 'English', nativeName: 'English', region: 'Australia', elevenLabsCode: 'en' },
    { code: 'en-CA', name: 'English', nativeName: 'English', region: 'Canada', elevenLabsCode: 'en' },
    { code: 'es-ES', name: 'Spanish', nativeName: 'Español', region: 'Spain', elevenLabsCode: 'es' },
    { code: 'es-MX', name: 'Spanish', nativeName: 'Español', region: 'Mexico', elevenLabsCode: 'es' },
    { code: 'es-AR', name: 'Spanish', nativeName: 'Español', region: 'Argentina', elevenLabsCode: 'es' },
    { code: 'fr-FR', name: 'French', nativeName: 'Français', region: 'France', elevenLabsCode: 'fr' },
    { code: 'fr-CA', name: 'French', nativeName: 'Français', region: 'Canada', elevenLabsCode: 'fr' },
    { code: 'de-DE', name: 'German', nativeName: 'Deutsch', region: 'Germany', elevenLabsCode: 'de' },
    { code: 'de-AT', name: 'German', nativeName: 'Deutsch', region: 'Austria', elevenLabsCode: 'de' },
    { code: 'it-IT', name: 'Italian', nativeName: 'Italiano', elevenLabsCode: 'it' },
    { code: 'pt-BR', name: 'Portuguese', nativeName: 'Português', region: 'Brazil', elevenLabsCode: 'pt-br' },
    { code: 'pt-PT', name: 'Portuguese', nativeName: 'Português', region: 'Portugal', elevenLabsCode: 'pt' },
    { code: 'ru-RU', name: 'Russian', nativeName: 'Русский', elevenLabsCode: 'ru' },
    { code: 'zh-CN', name: 'Chinese', nativeName: '中文', region: 'Simplified', elevenLabsCode: 'zh' },
    { code: 'zh-TW', name: 'Chinese', nativeName: '中文', region: 'Traditional', elevenLabsCode: 'zh' },
    { code: 'ja-JP', name: 'Japanese', nativeName: '日本語', elevenLabsCode: 'ja' },
    { code: 'ko-KR', name: 'Korean', nativeName: '한국어', elevenLabsCode: 'ko' },
    { code: 'ar-SA', name: 'Arabic', nativeName: 'العربية', elevenLabsCode: 'ar' },
    { code: 'hi-IN', name: 'Hindi', nativeName: 'हिन्दी', elevenLabsCode: 'hi' },
    { code: 'nl-NL', name: 'Dutch', nativeName: 'Nederlands', elevenLabsCode: 'nl' },
    { code: 'sv-SE', name: 'Swedish', nativeName: 'Svenska', elevenLabsCode: 'sv' },
    { code: 'no-NO', name: 'Norwegian', nativeName: 'Norsk', elevenLabsCode: 'no' },
    { code: 'da-DK', name: 'Danish', nativeName: 'Dansk', elevenLabsCode: 'da' },
    { code: 'fi-FI', name: 'Finnish', nativeName: 'Suomi', elevenLabsCode: 'fi' },
    { code: 'pl-PL', name: 'Polish', nativeName: 'Polski', elevenLabsCode: 'pl' },
    { code: 'tr-TR', name: 'Turkish', nativeName: 'Türkçe', elevenLabsCode: 'tr' },
    { code: 'he-IL', name: 'Hebrew', nativeName: 'עברית' }, // Not supported by ElevenLabs
    { code: 'th-TH', name: 'Thai', nativeName: 'ไทย' }, // Not supported by ElevenLabs
    { code: 'vi-VN', name: 'Vietnamese', nativeName: 'Tiếng Việt', elevenLabsCode: 'vi' },
    { code: 'id-ID', name: 'Indonesian', nativeName: 'Bahasa Indonesia', elevenLabsCode: 'id' },
    { code: 'ms-MY', name: 'Malay', nativeName: 'Bahasa Melayu', elevenLabsCode: 'ms' },
    { code: 'uk-UA', name: 'Ukrainian', nativeName: 'Українська', elevenLabsCode: 'uk' },
    { code: 'cs-CZ', name: 'Czech', nativeName: 'Čeština', elevenLabsCode: 'cs' },
    { code: 'hu-HU', name: 'Hungarian', nativeName: 'Magyar', elevenLabsCode: 'hu' },
    { code: 'ro-RO', name: 'Romanian', nativeName: 'Română', elevenLabsCode: 'ro' },
    { code: 'bg-BG', name: 'Bulgarian', nativeName: 'Български', elevenLabsCode: 'bg' },
    { code: 'el-GR', name: 'Greek', nativeName: 'Ελληνικά', elevenLabsCode: 'el' },
    { code: 'hr-HR', name: 'Croatian', nativeName: 'Hrvatski', elevenLabsCode: 'hr' },
    { code: 'sk-SK', name: 'Slovak', nativeName: 'Slovenčina', elevenLabsCode: 'sk' },
    { code: 'sl-SI', name: 'Slovenian', nativeName: 'Slovenščina' }, // Not supported by ElevenLabs
    { code: 'et-EE', name: 'Estonian', nativeName: 'Eesti' }, // Not supported by ElevenLabs
    { code: 'lv-LV', name: 'Latvian', nativeName: 'Latviešu' }, // Not supported by ElevenLabs
    { code: 'lt-LT', name: 'Lithuanian', nativeName: 'Lietuvių' }, // Not supported by ElevenLabs
];

/**
 * Format display name for a language
 */
export const getLanguageDisplayName = (language: Language) => {
    const parts = [];
    
    if (language.name !== language.nativeName) {
        parts.push(`${language.name} (${language.nativeName})`);
    } else {
        parts.push(language.name);
    }
    
    if (language.region) {
        parts.push(language.region);
    }
    
    return parts.join(' - ');
};

/**
 * Find a language by its code (including null for autodetect)
 */
export const findLanguageByCode = (code: string | null): Language | undefined => {
    return LANGUAGES.find(lang => lang.code === code);
};

/**
 * Get the ElevenLabs language code for a given language
 */
export const getElevenLabsCode = (language: Language): ElevenLabsLanguage | undefined => {
    return language.elevenLabsCode;
};

/**
 * Get ElevenLabs code from user's language preference (handles null/autodetect)
 */
export const getElevenLabsCodeFromPreference = (
    languageCode: string | null
): ElevenLabsLanguage | undefined => {
    if (!languageCode) return undefined; // Auto-detect case
    const language = findLanguageByCode(languageCode);
    return language?.elevenLabsCode;
};

/**
 * Get all languages that support ElevenLabs
 */
export const getElevenLabsSupportedLanguages = (): Language[] => {
    return LANGUAGES.filter(lang => lang.elevenLabsCode !== undefined);
};