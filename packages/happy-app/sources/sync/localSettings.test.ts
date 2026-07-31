import { describe, it, expect } from 'vitest';
import { localSettingsDefaults, localSettingsParse } from './localSettings';

describe('localSettings hapticFeedbackEnabled', () => {
    it('defaults to true', () => {
        expect(localSettingsDefaults.hapticFeedbackEnabled).toBe(true);
    });

    it('falls back to default when absent in stored data', () => {
        const parsed = localSettingsParse({ themePreference: 'dark' });
        expect(parsed.hapticFeedbackEnabled).toBe(true);
    });

    it('respects a stored false value', () => {
        const parsed = localSettingsParse({ hapticFeedbackEnabled: false });
        expect(parsed.hapticFeedbackEnabled).toBe(false);
    });
});

describe('localSettings desktop workspace panels', () => {
    it('keeps both desktop panels expanded by default', () => {
        expect(localSettingsDefaults.desktopLeftSidebarCollapsed).toBe(false);
        expect(localSettingsDefaults.desktopRightPanelCollapsed).toBe(false);
    });

    it('preserves independent collapse preferences when older data only has Zen mode', () => {
        const parsed = localSettingsParse({ zenMode: true });

        expect(parsed.zenMode).toBe(true);
        expect(parsed.desktopLeftSidebarCollapsed).toBe(false);
        expect(parsed.desktopRightPanelCollapsed).toBe(false);
    });

    it('restores independently stored panel preferences', () => {
        const parsed = localSettingsParse({
            zenMode: false,
            desktopLeftSidebarCollapsed: true,
            desktopRightPanelCollapsed: false,
        });

        expect(parsed.desktopLeftSidebarCollapsed).toBe(true);
        expect(parsed.desktopRightPanelCollapsed).toBe(false);
    });
});

describe('localSettings ask API config', () => {
    it('defaults to an unconfigured ask API', () => {
        expect(localSettingsDefaults.askApi).toEqual({
            apiKey: '',
            baseUrl: '',
            tavilyApiKey: '',
        });
    });

    it('preserves stored ask API credentials locally', () => {
        const parsed = localSettingsParse({
            askApi: {
                apiKey: ' sk-deepseek ',
                baseUrl: ' https://api.deepseek.com ',
                tavilyApiKey: ' tvly-local ',
            },
        });

        expect(parsed.askApi).toEqual({
            apiKey: ' sk-deepseek ',
            baseUrl: ' https://api.deepseek.com ',
            tavilyApiKey: ' tvly-local ',
        });
    });

    it('defaults Tavily credentials when older stored ask API data is missing them', () => {
        const parsed = localSettingsParse({
            askApi: {
                apiKey: ' sk-deepseek ',
                baseUrl: ' https://api.deepseek.com ',
            },
        });

        expect(parsed.askApi).toEqual({
            apiKey: ' sk-deepseek ',
            baseUrl: ' https://api.deepseek.com ',
            tavilyApiKey: '',
        });
    });
});
