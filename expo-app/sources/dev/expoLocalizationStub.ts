// Vitest runs in a Node environment; `expo-localization` depends on Expo modules that are not present.
// This stub provides the minimal surface needed by `sources/text/index.ts`.

export type Locale = {
    languageCode?: string | null;
    languageScriptCode?: string | null;
};

export function getLocales(): Locale[] {
    return [{ languageCode: 'en', languageScriptCode: null }];
}

