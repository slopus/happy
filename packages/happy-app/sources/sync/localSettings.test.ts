import { describe, it, expect } from 'vitest';
import { localSettingsDefaults, localSettingsParse } from './localSettings';

describe('localSettings web command palette', () => {
    it('drops removed command palette flags from stale local settings', () => {
        const parsed = localSettingsParse({
            commandPaletteEnabled: false,
            commandPaletteShortcutMigrated: true,
        });

        expect(parsed).not.toHaveProperty('commandPaletteEnabled');
        expect(parsed).not.toHaveProperty('commandPaletteShortcutMigrated');
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
        expect(localSettingsDefaults.desktopLeftSidebarWidth).toBe(580);
        expect(localSettingsDefaults.desktopRightPanelWidth).toBe(320);
        expect(localSettingsDefaults.desktopSidebarOrganizationCollapsed).toBe(false);
        expect(localSettingsDefaults.desktopSidebarOrganizationWidth).toBe(220);
    });

    it('preserves independent collapse preferences when older data only has Zen mode', () => {
        const parsed = localSettingsParse({ zenMode: true });

        expect(parsed.zenMode).toBe(true);
        expect(parsed.desktopLeftSidebarCollapsed).toBe(false);
        expect(parsed.desktopRightPanelCollapsed).toBe(false);
        expect(parsed.desktopLeftSidebarWidth).toBe(580);
        expect(parsed.desktopRightPanelWidth).toBe(320);
        expect(parsed.desktopSidebarOrganizationCollapsed).toBe(false);
        expect(parsed.desktopSidebarOrganizationWidth).toBe(220);
    });

    it('restores independently stored panel preferences', () => {
        const parsed = localSettingsParse({
            zenMode: false,
            desktopLeftSidebarCollapsed: true,
            desktopRightPanelCollapsed: false,
            desktopLeftSidebarWidth: 412,
            desktopRightPanelWidth: 388,
            desktopSidebarOrganizationCollapsed: true,
            desktopSidebarOrganizationWidth: 268,
        });

        expect(parsed.desktopLeftSidebarCollapsed).toBe(true);
        expect(parsed.desktopRightPanelCollapsed).toBe(false);
        expect(parsed.desktopLeftSidebarWidth).toBe(412);
        expect(parsed.desktopRightPanelWidth).toBe(388);
        expect(parsed.desktopSidebarOrganizationCollapsed).toBe(true);
        expect(parsed.desktopSidebarOrganizationWidth).toBe(268);
    });
});

describe('localSettings session list layout', () => {
    it('defaults older installs to project grouping and restores the time layout', () => {
        expect(localSettingsDefaults.sessionListLayout).toBe('projects');
        expect(localSettingsParse({}).sessionListLayout).toBe('projects');
        expect(localSettingsParse({ sessionListLayout: 'time' }).sessionListLayout).toBe('time');
        expect(localSettingsParse({ sessionListLayout: 'time' }).desktopSidebarMode).toBe('timeline');
    });
});

describe('localSettings desktop Lists and Tags', () => {
    it('keeps Projects as the default desktop sidebar mode', () => {
        expect(localSettingsDefaults.desktopSidebarMode).toBe('projects');
        expect(localSettingsParse({}).desktopSidebarMode).toBe('projects');
        expect(localSettingsParse({ desktopSidebarMode: 'lists' }).desktopSidebarMode).toBe('lists');
        expect(localSettingsParse({ desktopSidebarMode: 'timeline' }).desktopSidebarMode).toBe('timeline');
    });

    it('persists one List and multiple Tags for a session', () => {
        const sidebarOrganization = {
            folders: [],
            lists: [{
                id: 'happy', name: 'Happy', kind: 'workspace' as const, color: 'blue' as const,
                machineId: 'mac-mini', path: '~/happy', defaultAgent: 'codex' as const, createdAt: 1,
            }],
            tags: [
                { id: 'product', name: 'product', color: 'green' as const, createdAt: 1 },
                { id: 'code', name: 'code', color: 'purple' as const, createdAt: 2 },
            ],
            sessions: { 'session-1': { listId: 'happy', tagIds: ['product', 'code'] } },
        };

        expect(localSettingsParse({ sidebarOrganization }).sidebarOrganization).toEqual(sidebarOrganization);
    });

    it('strips workspace presets and legacy prompts from Agent Lists', () => {
        const parsed = localSettingsParse({
            sidebarOrganization: {
                lists: [{
                    id: 'advisor', name: 'Advisor', kind: 'agent', color: 'pink', prompt: 'legacy prompt', createdAt: 1,
                    machineId: 'must-not-survive', path: '/must-not-survive',
                }],
                tags: [],
                sessions: {},
            },
        });

        expect(parsed.sidebarOrganization.lists[0]).toEqual({
            id: 'advisor', name: 'Advisor', kind: 'agent', color: 'pink', createdAt: 1,
        });
    });

    it('drops only invalid organization data instead of resetting unrelated local settings', () => {
        const parsed = localSettingsParse({
            themePreference: 'dark',
            sidebarOrganization: {
                lists: [{ id: 'bad', name: 'x'.repeat(81), kind: 'agent', color: 'pink', createdAt: 1 }],
                tags: [],
                sessions: {},
            },
        });

        expect(parsed.themePreference).toBe('dark');
        expect(parsed.sidebarOrganization).toEqual({ folders: [], lists: [], tags: [], sessions: {} });
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
    it('migrates the old single transcript into one named conversation', () => {
        expect(localSettingsParse({}).relationshipAdvisorConversations).toEqual([]);
        const messages = [{
            id: 'message-1',
            role: 'user' as const,
            text: '右侧蓝色气泡是我',
            createdAt: 1_786_400_000_000,
            imageCount: 1,
        }];

        const parsed = localSettingsParse({ relationshipAdvisorMessages: messages });
        expect(parsed.relationshipAdvisorMessages).toEqual([]);
        expect(parsed.relationshipAdvisorConversations).toEqual([{
            id: 'legacy-relationship-advisor',
            title: '右侧蓝色气泡是我',
            createdAt: 1_786_400_000_000,
            updatedAt: 1_786_400_000_000,
            messages,
        }]);
    });

    it('preserves an existing multi-conversation history without reimporting legacy messages', () => {
        const conversations = [{
            id: 'conversation-1',
            title: '她只回了哈哈',
            createdAt: 10,
            updatedAt: 20,
            messages: [],
        }];

        expect(localSettingsParse({
            relationshipAdvisorConversations: conversations,
            relationshipAdvisorMessages: [{
                id: 'legacy-message',
                role: 'user',
                text: '旧记录',
                createdAt: 1,
                imageCount: 0,
            }],
        }).relationshipAdvisorConversations).toEqual(conversations);
    });

    it('keeps an untranslated empty title for legacy transcripts without a user message', () => {
        const messages = [{
            id: 'message-1',
            role: 'assistant' as const,
            text: '先说说情况',
            createdAt: 1_786_400_000_000,
            imageCount: 0,
        }];

        expect(localSettingsParse({ relationshipAdvisorMessages: messages }).relationshipAdvisorConversations).toEqual([{
            id: 'legacy-relationship-advisor',
            title: '',
            createdAt: 1_786_400_000_000,
            updatedAt: 1_786_400_000_000,
            messages,
        }]);
    });
});
