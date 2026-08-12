import { describe, it, expect } from 'vitest';
import { localSettingsDefaults, localSettingsParse } from './localSettings';

describe('localSettings web command palette', () => {
    it('is available by default while preserving an explicit opt-out', () => {
        expect(localSettingsDefaults.commandPaletteEnabled).toBe(true);
        expect(localSettingsParse({}).commandPaletteEnabled).toBe(true);
        expect(localSettingsParse({ commandPaletteEnabled: false }).commandPaletteEnabled).toBe(false);
    });
});

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
        expect(localSettingsDefaults.desktopLeftSidebarWidth).toBe(360);
        expect(localSettingsDefaults.desktopRightPanelWidth).toBe(320);
    });

    it('preserves independent collapse preferences when older data only has Zen mode', () => {
        const parsed = localSettingsParse({ zenMode: true });

        expect(parsed.zenMode).toBe(true);
        expect(parsed.desktopLeftSidebarCollapsed).toBe(false);
        expect(parsed.desktopRightPanelCollapsed).toBe(false);
        expect(parsed.desktopLeftSidebarWidth).toBe(360);
        expect(parsed.desktopRightPanelWidth).toBe(320);
    });

    it('restores independently stored panel preferences', () => {
        const parsed = localSettingsParse({
            zenMode: false,
            desktopLeftSidebarCollapsed: true,
            desktopRightPanelCollapsed: false,
            desktopLeftSidebarWidth: 412,
            desktopRightPanelWidth: 388,
        });

        expect(parsed.desktopLeftSidebarCollapsed).toBe(true);
        expect(parsed.desktopRightPanelCollapsed).toBe(false);
        expect(parsed.desktopLeftSidebarWidth).toBe(412);
        expect(parsed.desktopRightPanelWidth).toBe(388);
    });
});

describe('localSettings session list layout', () => {
    it('defaults older installs to project grouping and restores the time layout', () => {
        expect(localSettingsDefaults.sessionListLayout).toBe('projects');
        expect(localSettingsParse({}).sessionListLayout).toBe('projects');
        expect(localSettingsParse({ sessionListLayout: 'time' }).sessionListLayout).toBe('time');
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

describe('localSettings relationship advisor history', () => {
    it('keeps a bounded device-local transcript and defaults older installs to empty', () => {
        expect(localSettingsParse({}).relationshipAdvisorMessages).toEqual([]);
        const messages = [{
            id: 'message-1',
            role: 'user' as const,
            text: '右侧蓝色气泡是我',
            createdAt: 1_786_400_000_000,
            imageCount: 1,
        }];

        expect(localSettingsParse({ relationshipAdvisorMessages: messages }).relationshipAdvisorMessages).toEqual(messages);
    });
});
