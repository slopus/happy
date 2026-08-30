import * as z from 'zod';
import { isHealthCheckinSession } from '@/utils/healthLog';
import { AgentLauncherListSchema } from './settings';
import {
    DESKTOP_LEFT_PANEL_DEFAULT_WIDTH,
    DESKTOP_RIGHT_PANEL_DEFAULT_WIDTH,
} from '@/utils/desktopNavigationLayout';
import {
    buildRelationshipAdvisorConversationTitle,
    limitRelationshipAdvisorConversations,
    MAX_RELATIONSHIP_ADVISOR_CONVERSATIONS,
    MAX_RELATIONSHIP_ADVISOR_MESSAGES,
} from '@/components/relationship-advisor/relationshipAdvisorHistoryModel';
import {
    emptySidebarOrganization,
    SidebarOrganizationSchema,
} from './sidebarOrganization';

//
// Schema
//

const RelationshipAdvisorMessageSchema = z.object({
    id: z.string().min(1).max(100),
    role: z.enum(['user', 'assistant']),
    text: z.string().max(12_000),
    createdAt: z.number().finite(),
    imageCount: z.number().int().min(0).max(4),
});

const RelationshipAdvisorConversationSchema = z.object({
    id: z.string().min(1).max(100),
    title: z.string().max(120),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite(),
    messages: z.array(RelationshipAdvisorMessageSchema).max(MAX_RELATIONSHIP_ADVISOR_MESSAGES),
});

export const LocalSettingsSchema = z.object({
    // Developer settings (device-specific)
    debugMode: z.boolean().describe('Enable debug logging'),
    devModeEnabled: z.boolean().describe('Enable developer menu in settings'),
    voiceUpsellOverride: z.enum(['control', 'show-paywall-before-first-voice-chat', 'voice-onboarding-and-upsell']).nullable().describe('Developer-only local override for the voice-upsell PostHog flag'),
    themePreference: z.enum(['light', 'dark', 'adaptive']).describe('Theme preference: light, dark, or adaptive (follows system)'),
    themePack: z.enum(['caramel', 'gingham', 'terminal', 'acorn', 'sage', 'sakura', 'grape']).describe('Color theme pack (brand accent variant)'),
    mascot: z.enum(['hoodie', 'explorer', 'astro', 'barista', 'ninja', 'scientist', 'florist']).describe('Mascot character shown on the empty home screen and settings header'),
    markdownCopyV2: z.boolean().describe('Replace native paragraph selection with long-press modal for full markdown copy'),
    consoleLoggingEnabled: z.boolean().describe('Enable console output in production builds'),
    verboseLogging: z.boolean().describe('Log all network requests and responses'),
    zenMode: z.boolean().describe('Hide all sidebars and non-essential UI for focused work'),
    desktopLeftSidebarCollapsed: z.boolean().describe('Collapse the desktop session sidebar independently of Zen mode'),
    desktopRightPanelCollapsed: z.boolean().describe('Collapse the desktop capability panel independently of Zen mode'),
    desktopLeftSidebarWidth: z.number().finite().describe('Preferred width of the desktop session sidebar'),
    desktopRightPanelWidth: z.number().finite().describe('Preferred width of the desktop capability panel'),
    sessionListLayout: z.enum(['projects', 'time']).describe('Preferred session sidebar grouping'),
    desktopSidebarMode: z.enum(['projects', 'lists', 'timeline']).describe('Desktop session sidebar primary mode'),
    sidebarOrganization: SidebarOrganizationSchema.describe('Legacy device-local session Lists and Tags, retained for account-sync migration'),
    // 「Agent 空间模式」：进入某个「我的 Agent」后，左侧侧栏收敛为该 Agent 的专属工作台
    // （仅本空间会话 + 预设快捷指令 + 退出空间）。存 agent id；null 为全局视图。刻意放设备本地、
    // 不随账号同步（同 agents/zenMode），避免被同步 churn 冲掉。
    agentSpaceId: z.string().nullable().describe('当前进入的「我的 Agent」空间（agent id），null 为全局视图'),
    hapticFeedbackEnabled: z.boolean().describe('Enable haptic (vibration) feedback for interactions'),
    askApi: z.object({
        apiKey: z.string().describe('DeepSeek-compatible API key for Ask mode'),
        baseUrl: z.string().describe('Optional DeepSeek-compatible API base URL for Ask mode'),
        tavilyApiKey: z.string().optional().default('').describe('Optional Tavily API key for Ask mode web search'),
    }).describe('Device-local Ask mode API credentials'),
    // CLI version acknowledgments - keyed by machineId
    acknowledgedCliVersions: z.record(z.string(), z.string()).describe('Acknowledged CLI versions per machine'),
    // 「我的 Agent」启动预设。**刻意放在设备本地、不随账号同步**：账号设置是「单一加密 blob +
    // 乐观锁 + POST 整包覆盖、后写赢」，App 各种 churn 写入会把 agents 一起带上，某次本地为空即把
    // 服务器覆盖空，导致新建 Agent 退出重进就丢。放本地后任何同步/WS 回包都碰不到它，彻底解决。
    agents: AgentLauncherListSchema.describe('设备本地「我的 Agent」启动预设（不随账号同步）'),
    relationshipAdvisorConversations: z.array(RelationshipAdvisorConversationSchema)
        .max(MAX_RELATIONSHIP_ADVISOR_CONVERSATIONS)
        .describe('设备本地狗头军师会话历史'),
    relationshipAdvisorMessages: z.array(RelationshipAdvisorMessageSchema)
        .max(MAX_RELATIONSHIP_ADVISOR_MESSAGES)
        .describe('旧版设备本地狗头军师单对话，仅用于迁移'),
    healthSleepStructureView: z.enum(['bar', 'donut']).describe('健康打卡睡眠结构可视化：堆叠条/甜甜圈'),
    healthSleepTrendMetric: z.enum(['duration', 'score']).describe('健康打卡本周趋势指标：时长/评分'),
    healthActiveDomain: z.enum(['sleep', 'exercise', 'diet']).describe('健康打卡面板当前域：睡眠/运动/饮食'),
});

//
// NOTE: Local settings are device-specific and should NOT be synced.
// These are preferences that make sense to be different on each device.
//

const LocalSettingsSchemaPartial = LocalSettingsSchema.passthrough().partial();

export type LocalSettings = z.infer<typeof LocalSettingsSchema>;

//
// Defaults
//

export const localSettingsDefaults: LocalSettings = {
    debugMode: false,
    devModeEnabled: false,
    voiceUpsellOverride: null,
    themePreference: 'adaptive',
    themePack: 'caramel',
    mascot: 'hoodie',
    markdownCopyV2: false,
    consoleLoggingEnabled: false,
    verboseLogging: false,
    zenMode: false,
    desktopLeftSidebarCollapsed: false,
    desktopRightPanelCollapsed: false,
    desktopLeftSidebarWidth: DESKTOP_LEFT_PANEL_DEFAULT_WIDTH,
    desktopRightPanelWidth: DESKTOP_RIGHT_PANEL_DEFAULT_WIDTH,
    sessionListLayout: 'projects',
    desktopSidebarMode: 'projects',
    sidebarOrganization: {
        lists: [],
        tags: [],
        sessions: {},
    },
    agentSpaceId: null,
    hapticFeedbackEnabled: true,
    askApi: {
        apiKey: '',
        baseUrl: '',
        tavilyApiKey: '',
    },
    acknowledgedCliVersions: {},
    agents: [],
    relationshipAdvisorConversations: [],
    relationshipAdvisorMessages: [],
    healthSleepStructureView: 'bar',
    healthSleepTrendMetric: 'duration',
    healthActiveDomain: 'sleep',
};
Object.freeze(localSettingsDefaults);

//
// Parsing
//

function removeDeprecatedLocalSettings(settings: unknown): unknown {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        return settings;
    }

    const {
        commandPaletteEnabled: _commandPaletteEnabled,
        commandPaletteShortcutMigrated: _commandPaletteShortcutMigrated,
        ...remainingSettings
    } = settings as Record<string, unknown>;

    return remainingSettings;
}

function migrateLegacyAgentSpaceTypes(settings: unknown): unknown {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        return settings;
    }

    const agents = (settings as { agents?: unknown }).agents;
    if (!Array.isArray(agents)) {
        return settings;
    }

    let changed = false;
    const migratedAgents = agents.map((agent) => {
        if (!agent || typeof agent !== 'object' || Array.isArray(agent) || Object.prototype.hasOwnProperty.call(agent, 'spaceType')) {
            return agent;
        }

        changed = true;
        const path = typeof (agent as { path?: unknown }).path === 'string'
            ? (agent as { path: string }).path
            : undefined;
        return {
            ...agent,
            spaceType: isHealthCheckinSession(path) ? 'health' : 'default',
        };
    });

    return changed ? { ...settings, agents: migratedAgents } : settings;
}

function migrateLegacyRelationshipAdvisorMessages(settings: unknown): unknown {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return settings;

    const value = settings as {
        relationshipAdvisorConversations?: unknown;
        relationshipAdvisorMessages?: unknown;
    };
    if (Array.isArray(value.relationshipAdvisorConversations)
        || !Array.isArray(value.relationshipAdvisorMessages)
        || value.relationshipAdvisorMessages.length === 0) {
        return settings;
    }

    const parsedMessages = z.array(RelationshipAdvisorMessageSchema)
        .max(MAX_RELATIONSHIP_ADVISOR_MESSAGES)
        .safeParse(value.relationshipAdvisorMessages);
    if (!parsedMessages.success || parsedMessages.data.length === 0) return settings;

    const createdAt = parsedMessages.data[0]?.createdAt ?? Date.now();
    const updatedAt = parsedMessages.data.at(-1)?.createdAt ?? createdAt;
    return {
        ...settings,
        relationshipAdvisorConversations: [{
            id: 'legacy-relationship-advisor',
            title: buildRelationshipAdvisorConversationTitle(parsedMessages.data),
            createdAt,
            updatedAt,
            messages: parsedMessages.data,
        }],
        relationshipAdvisorMessages: [],
    };
}

export function localSettingsParse(settings: unknown): LocalSettings {
    const parsed = LocalSettingsSchemaPartial.safeParse(
        removeDeprecatedLocalSettings(
            migrateLegacyRelationshipAdvisorMessages(migrateLegacyAgentSpaceTypes(settings)),
        ),
    );
    if (!parsed.success) {
        return { ...localSettingsDefaults };
    }
    return {
        ...localSettingsDefaults,
        ...parsed.data,
        desktopSidebarMode: parsed.data.desktopSidebarMode
            ?? (parsed.data.sessionListLayout === 'time' ? 'timeline' : localSettingsDefaults.desktopSidebarMode),
        relationshipAdvisorConversations: limitRelationshipAdvisorConversations(
            parsed.data.relationshipAdvisorConversations ?? localSettingsDefaults.relationshipAdvisorConversations,
        ),
        askApi: {
            ...localSettingsDefaults.askApi,
            ...parsed.data.askApi,
        },
    };
}

//
// Applying changes
//

export function applyLocalSettings(settings: LocalSettings, delta: Partial<LocalSettings>): LocalSettings {
    return { ...localSettingsDefaults, ...settings, ...delta };
}
