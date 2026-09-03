import * as z from 'zod';
import { AgentDefaultOverridesSchema } from './agentDefaults';
import {
    emptySidebarOrganization,
    isValidSidebarOrganizationPayload,
    serializeSidebarOrganizationWithRaw,
    isSidebarOrganizationEmpty,
    normalizeSidebarOrganization,
    SidebarOrganizationSchema,
    type SidebarOrganization,
} from './sidebarOrganization';

//
// Settings Schema
//

// Current schema version for backward compatibility
export const SUPPORTED_SCHEMA_VERSION = 2;

export const QuickPromptSchema = z.object({
    id: z.string(),
    title: z.string(),
    prompt: z.string(),
    createdAt: z.number().optional(),
    updatedAt: z.number().optional(),
});

const StrictSessionPinnedOrderSchema = z.array(z.string().min(1));

export const SessionPinnedOrderSchema = StrictSessionPinnedOrderSchema
    .transform((items) => Array.from(new Set(items)))
    .catch([]);

export function isValidSessionPinnedOrderPayload(value: unknown): value is string[] {
    return StrictSessionPinnedOrderSchema.safeParse(value).success;
}

const ImageStyleReferenceImageSchema = z.object({
    id: z.string(),
    uri: z.string(),
    width: z.number(),
    height: z.number(),
    mimeType: z.string(),
    size: z.number(),
    name: z.string(),
    thumbhash: z.string().optional(),
});

const UserImageStyleSchema = z.object({
    id: z.string(),
    title: z.string(),
    promptHint: z.string(),
    promptContent: z.string().optional(),
    negativePrompt: z.string().optional(),
    tags: z.array(z.string()).default([]),
    analysisStatus: z.enum(['reference-ready', 'analyzing', 'prompt-ready', 'failed']).default('reference-ready'),
    analysisError: z.string().optional(),
    analysisSessionId: z.string().optional(),
    analyzedAt: z.number().optional(),
    promptSource: z.enum(['reference-image', 'extracted-prompt', 'manual']).default('reference-image'),
    referenceImages: z.array(ImageStyleReferenceImageSchema).default([]),
    createdAt: z.number(),
    updatedAt: z.number(),
});

// 「我的 Agent」启动预设列表的 schema。抽成导出常量，供 localSettings 复用同一形状——
// agents 已改为设备本地存储（localSettings，不随账号同步），避免被账号设置「单一 blob 整包
// 覆盖」的同步链路清空（见 experience：Agent 配置丢失）。此处 SettingsSchema 仍保留 agents
// 字段仅为兼容旧数据/类型，运行时不再作为真源写入。
export const AgentLauncherListSchema = z.array(z.object({
    id: z.string(),
    name: z.string(),
    glyph: z.string(),
    color: z.string(),
    machineId: z.string(),
    path: z.string(),
    kind: z.enum(['standard', 'image-styles']).default('standard'),
    spaceType: z.enum(['default', 'health']).default('default'),
    imageStyleIds: z.array(z.string()).default([]),
    imageVariantsPerStyle: z.number().int().min(1).max(4).default(1),
    presets: z.array(z.object({
        label: z.string(),
        prompt: z.string(),
    })).default([]),
    // 空间预设的默认引擎 / 模型 / 思考强度（进入该 Agent 新建会话时套用）。
    agentType: z.enum(['ask', 'claude', 'codex', 'gemini', 'opencode', 'openclaw']).optional(),
    runtime: z.enum(['relationship-advisor']).optional(),
    permissionMode: z.string().optional(),
    modelMode: z.string().optional(),
    effortLevel: z.string().nullish(),
})).default([]);

export const SettingsSchema = z.object({
    // Schema version for compatibility detection
    schemaVersion: z.number().default(SUPPORTED_SCHEMA_VERSION).describe('Settings schema version for compatibility checks'),

    customInstructions: z.string().describe('User-defined instructions appended to the system prompt of every message'),
    viewInline: z.boolean().describe('Whether to view inline tool calls'),
    inferenceOpenAIKey: z.string().nullish().describe('OpenAI API key for inference'),
    expandTodos: z.boolean().describe('Whether to expand todo lists'),
    showLineNumbers: z.boolean().describe('Whether to show line numbers in diffs'),
    showLineNumbersInToolViews: z.boolean().describe('Whether to show line numbers in tool view diffs'),
    wrapLinesInDiffs: z.boolean().describe('Whether to wrap long lines in diff views'),
    diffStyle: z.enum(['unified', 'split']).describe('Diff view style (split is web-only)'),
    analyticsOptOut: z.boolean().describe('Whether to opt out of anonymous analytics'),
    experiments: z.boolean().describe('Whether to enable experimental features'),
    alwaysShowContextSize: z.boolean().describe('Always show context size in agent input'),
    agentInputEnterToSend: z.boolean().describe('Whether pressing Enter submits/sends in the agent input (web)'),
    avatarStyle: z.string().describe('Avatar display style'),
    showFlavorIcons: z.boolean().describe('Whether to show AI provider icons in avatars'),

    hideInactiveSessions: z.boolean().describe('Hide inactive sessions in the main list'),
    expResumeSession: z.boolean().describe('Enable experimental session resume feature'),
    fileDiffsSidebar: z.boolean().describe('Show the file diffs sidebar next to the chat on desktop'),
    groupToolCalls: z.boolean().describe('Collapse consecutive tool calls into grouped containers in chat'),
    expImageUpload: z.boolean().describe('Enable experimental image upload in chat'),
    expDesktopScreenshot: z.boolean().describe('Enable desktop screenshot capture in chat'),
    reviewPromptAnswered: z.boolean().describe('Whether the review prompt has been answered'),
    reviewPromptLikedApp: z.boolean().nullish().describe('Whether user liked the app when asked'),
    voiceAssistantLanguage: z.string().nullable().describe('Preferred language for voice assistant (null for auto-detect)'),
    voiceCustomAgentId: z.string().nullable().describe('Custom ElevenLabs agent ID (null to use Paws default)'),
    voiceBypassToken: z.boolean().describe('Bypass Paws server token and connect directly to ElevenLabs (requires custom agent ID)'),
    preferredLanguage: z.string().nullable().describe('Preferred UI language (null for auto-detect from device locale)'),
    recentMachinePaths: z.array(z.object({
        machineId: z.string(),
        path: z.string()
    })).describe('Last 10 machine-path combinations, ordered by most recent first'),
    quickPrompts: z.array(QuickPromptSchema).describe('User-defined quick prompts that can be sent from the right-side capability hub'),
    pendingCustomImageStyleReferences: z.array(ImageStyleReferenceImageSchema).default([]).describe('Draft reference images uploaded in GPT Image 2 style mode before the user saves them as a custom style.'),
    customImageStyles: z.array(UserImageStyleSchema).default([]).describe('User-created GPT Image 2 style assets. Reference images are usable immediately; extracted prompts can replace them when ready.'),
    lastUsedAgent: z.string().nullable().describe('Last selected agent type for new sessions'),
    lastUsedPermissionMode: z.string().nullable().describe('Last selected permission mode for new sessions'),
    lastUsedModelMode: z.string().nullable().describe('Last selected model mode for new sessions'),
    agentDefaultOverrides: AgentDefaultOverridesSchema.describe('User-selected agent defaults. Missing values use code defaults and are not sent as agent metadata.'),
    sessionPinnedOrder: SessionPinnedOrderSchema.describe('Account-synced pinned session IDs in display order'),
    sessionPinnedOrderRaw: z.unknown().nullable().describe('Locally preserved future-format pinned-session data; written back unchanged until the user edits pins'),
    sidebarOrganization: SidebarOrganizationSchema.describe('Account-synced session Lists, Tags, and assignments'),
    sidebarOrganizationRaw: z.unknown().nullable().describe('Locally preserved future-format sidebar records; reconstructed into sidebarOrganization before sync'),
    // Dismissed CLI warning banners (supports both per-machine and global dismissal)
    dismissedCLIWarnings: z.object({
        perMachine: z.record(z.string(), z.object({
            claude: z.boolean().optional(),
            codex: z.boolean().optional(),
            gemini: z.boolean().optional(),
            opencode: z.boolean().optional(),
            openclaw: z.boolean().optional(),
        })).default({}),
        global: z.object({
            claude: z.boolean().optional(),
            codex: z.boolean().optional(),
            gemini: z.boolean().optional(),
            opencode: z.boolean().optional(),
            openclaw: z.boolean().optional(),
        }).default({}),
    }).default({ perMachine: {}, global: {} }).describe('Tracks which CLI installation warnings user has dismissed (per-machine or globally)'),
    agents: AgentLauncherListSchema.describe('（已迁移到 localSettings·设备本地）保留仅为兼容；运行时真源在 localSettings.agents'),
});

//
// NOTE: Settings must be a flat object with no to minimal nesting, one field == one setting,
// you can name them with a prefix if you want to group them, but don't nest them.
// You can nest if value is a single value (like image with url and width and height)
// Settings are always merged with defaults and field by field.
//
// This structure must be forward and backward compatible. Meaning that some versions of the app
// could be missing some fields or have a new fields. Everything must be preserved and client must
// only touch the fields it knows about.
//

const SettingsSchemaPartial = SettingsSchema.partial();

export type Settings = z.infer<typeof SettingsSchema>;
export type QuickPrompt = z.infer<typeof QuickPromptSchema>;

//
// Defaults
//

export const settingsDefaults: Settings = {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    customInstructions: '',
    viewInline: false,
    inferenceOpenAIKey: null,
    expandTodos: true,
    showLineNumbers: true,
    showLineNumbersInToolViews: false,
    wrapLinesInDiffs: true,
    diffStyle: 'unified',
    analyticsOptOut: false,
    experiments: false,
    alwaysShowContextSize: false,
    agentInputEnterToSend: true,
    avatarStyle: 'brutalist',
    showFlavorIcons: false,

    hideInactiveSessions: true,
    expResumeSession: false,
    fileDiffsSidebar: false,
    groupToolCalls: false,
    expImageUpload: false,
    expDesktopScreenshot: true,
    reviewPromptAnswered: false,
    reviewPromptLikedApp: null,
    voiceAssistantLanguage: null,
    voiceCustomAgentId: null,
    voiceBypassToken: false,
    preferredLanguage: null,
    recentMachinePaths: [],
    quickPrompts: [],
    pendingCustomImageStyleReferences: [],
    customImageStyles: [],
    lastUsedAgent: null,
    lastUsedPermissionMode: null,
    lastUsedModelMode: null,
    agentDefaultOverrides: {},
    sessionPinnedOrder: [],
    sessionPinnedOrderRaw: null,
    sidebarOrganization: emptySidebarOrganization,
    sidebarOrganizationRaw: null,
    dismissedCLIWarnings: { perMachine: {}, global: {} },
    agents: [],
};
Object.freeze(settingsDefaults);

//
// Resolving
//

export function settingsParse(settings: unknown): Settings {
    // Handle null/undefined/invalid inputs
    if (!settings || typeof settings !== 'object') {
        return { ...settingsDefaults };
    }

    const parsed = SettingsSchemaPartial.safeParse(settings);
    if (!parsed.success) {
        // For invalid settings, preserve unknown fields but use defaults for known fields
        const unknownFields = { ...(settings as any) };
        // Remove all known schema fields from unknownFields
        const knownFields = Object.keys(SettingsSchema.shape);
        knownFields.forEach(key => delete unknownFields[key]);
        return { ...settingsDefaults, ...unknownFields };
    }

    // Migration: Convert old 'zh' language code to 'zh-Hans'
    if (parsed.data.preferredLanguage === 'zh') {
        console.log('[Settings Migration] Converting language code from "zh" to "zh-Hans"');
        parsed.data.preferredLanguage = 'zh-Hans';
    }

    // Merge defaults, parsed settings, and preserve unknown fields
    const unknownFields = { ...(settings as any) };
    // Remove known fields from unknownFields to preserve only the unknown ones
    Object.keys(parsed.data).forEach(key => delete unknownFields[key]);

    const rawSidebarOrganization = Object.prototype.hasOwnProperty.call(settings, 'sidebarOrganization')
        ? (settings as { sidebarOrganization: unknown }).sidebarOrganization
        : undefined;
    const rawSessionPinnedOrder = Object.prototype.hasOwnProperty.call(settings, 'sessionPinnedOrder')
        ? (settings as { sessionPinnedOrder: unknown }).sessionPinnedOrder
        : undefined;
    return {
        ...settingsDefaults,
        ...parsed.data,
        ...unknownFields,
        sidebarOrganizationRaw: isValidSidebarOrganizationPayload(rawSidebarOrganization)
            ? null
            : rawSidebarOrganization ?? null,
        sessionPinnedOrderRaw: isValidSessionPinnedOrderPayload(rawSessionPinnedOrder)
            ? null
            : rawSessionPinnedOrder ?? null,
    };
}

//
// Applying changes
// NOTE: May be something more sophisticated here around defaults and merging, but for now this is fine.
//

export function applySettings(settings: Settings, delta: Partial<Settings>): Settings {
    // Original behavior: start with settings, apply delta, fill in missing with defaults
    const result = { ...settings, ...delta };

    // Fill in any missing fields with defaults
    Object.keys(settingsDefaults).forEach(key => {
        if (!(key in result)) {
            (result as any)[key] = (settingsDefaults as any)[key];
        }
    });

    return result;
}

function hasOwnField(value: unknown, field: string): boolean {
    return !!value
        && typeof value === 'object'
        && !Array.isArray(value)
        && Object.prototype.hasOwnProperty.call(value, field);
}

export function resolveSidebarOrganizationMigration(
    rawServerSettings: unknown,
    currentOrganization: SidebarOrganization,
    legacyLocalOrganization: SidebarOrganization,
): { organization: SidebarOrganization; shouldUpload: boolean } {
    if (hasOwnField(rawServerSettings, 'sidebarOrganization')) {
        return { organization: currentOrganization, shouldUpload: false };
    }

    const organization = normalizeSidebarOrganization(isSidebarOrganizationEmpty(currentOrganization)
        ? legacyLocalOrganization
        : currentOrganization);
    return {
        organization,
        shouldUpload: !isSidebarOrganizationEmpty(organization),
    };
}

export function resolveSessionPinnedOrderMigration(
    rawServerSettings: unknown,
    currentPinnedOrder: string[],
    legacyLocalPinnedOrder: string[],
): { pinnedOrder: string[]; shouldUpload: boolean } {
    if (hasOwnField(rawServerSettings, 'sessionPinnedOrder')) {
        return { pinnedOrder: currentPinnedOrder, shouldUpload: false };
    }

    const pinnedOrder = currentPinnedOrder.length > 0
        ? currentPinnedOrder
        : legacyLocalPinnedOrder;
    return {
        pinnedOrder,
        shouldUpload: pinnedOrder.length > 0,
    };
}

export function mergeSessionPinnedOrders(
    basePinnedOrder: string[],
    localPinnedOrder: string[],
    remotePinnedOrder: string[],
): string[] {
    const base = new Set(basePinnedOrder);
    const local = new Set(localPinnedOrder);
    const remote = new Set(remotePinnedOrder);
    const finalPinned = new Set<string>();

    for (const sessionId of new Set([...basePinnedOrder, ...localPinnedOrder, ...remotePinnedOrder])) {
        const localChangedMembership = local.has(sessionId) !== base.has(sessionId);
        const included = localChangedMembership ? local.has(sessionId) : remote.has(sessionId);
        if (included) finalPinned.add(sessionId);
    }

    const baseOrder = Array.from(new Set(basePinnedOrder)).filter((id) => finalPinned.has(id));
    const localOrder = Array.from(new Set(localPinnedOrder)).filter((id) => finalPinned.has(id));
    const remoteOrder = Array.from(new Set(remotePinnedOrder)).filter((id) => finalPinned.has(id));
    const localBaseOrder = localOrder.filter((id) => base.has(id));
    const unchangedLocalBaseOrder = baseOrder.filter((id) => local.has(id));

    // If the local client only changed membership, retain the remote client's
    // independent ordering of the pre-existing pins and splice local additions
    // into the same leading/interior/trailing regions chosen locally.
    if (localBaseOrder.length === unchangedLocalBaseOrder.length
        && localBaseOrder.every((id, index) => id === unchangedLocalBaseOrder[index])) {
        const localAdditions = localOrder.filter((id) => !base.has(id));
        const localAdditionSet = new Set(localAdditions);
        const merged = remoteOrder.filter((id) => !localAdditionSet.has(id));
        const additionsByPreviousBase = new Map<string | null, string[]>();
        let previousBase: string | null = null;
        for (const id of localOrder) {
            if (base.has(id)) {
                previousBase = id;
            } else {
                const additions = additionsByPreviousBase.get(previousBase) ?? [];
                additions.push(id);
                additionsByPreviousBase.set(previousBase, additions);
            }
        }

        const leading = additionsByPreviousBase.get(null) ?? [];
        merged.unshift(...leading);
        for (const baseId of localBaseOrder) {
            const additions = additionsByPreviousBase.get(baseId) ?? [];
            if (additions.length === 0) continue;
            const baseIndex = merged.indexOf(baseId);
            merged.splice(baseIndex === -1 ? merged.length : baseIndex + 1, 0, ...additions);
        }
        return merged;
    }

    // Both sides reordered the existing pins. The pending local gesture wins,
    // while remote-only membership changes remain appended in remote order.
    return [...localOrder, ...remoteOrder].filter((id, index, ids) => ids.indexOf(id) === index);
}

export function mergeServerSettings(
    currentSettings: Settings,
    serverSettings: Settings,
    pendingSettings: Partial<Settings>,
    rawServerSettings: unknown,
): Settings {
    // Fields stored in the whole-blob account settings must NOT be wiped when an
    // incoming payload simply OMITS them — e.g. an older/other client that predates
    // the field, or a reload/resync race. Without this guard, the server blob's
    // absence of the field silently drops the user's local data. `agents` already
    // had this protection; `customImageStyles` needs the same, otherwise a resync
    // (e.g. right after an OTA reload) can erase every saved custom style.
    // An explicit value from the server (even []) still wins, so intentional
    // cross-device changes/deletes keep propagating.
    let baseSettings: Settings = serverSettings;
    if (!hasOwnField(pendingSettings, 'agents') && !hasOwnField(rawServerSettings, 'agents') && currentSettings.agents.length > 0) {
        baseSettings = { ...baseSettings, agents: currentSettings.agents };
    }
    if (!hasOwnField(pendingSettings, 'customImageStyles') && !hasOwnField(rawServerSettings, 'customImageStyles') && currentSettings.customImageStyles.length > 0) {
        baseSettings = { ...baseSettings, customImageStyles: currentSettings.customImageStyles };
    }
    if (!hasOwnField(pendingSettings, 'sidebarOrganization')
        && !hasOwnField(rawServerSettings, 'sidebarOrganization')
        && !isSidebarOrganizationEmpty(currentSettings.sidebarOrganization)) {
        baseSettings = { ...baseSettings, sidebarOrganization: currentSettings.sidebarOrganization };
    }
    if (!hasOwnField(pendingSettings, 'sessionPinnedOrder')
        && (!hasOwnField(rawServerSettings, 'sessionPinnedOrder')
            || !isValidSessionPinnedOrderPayload(
                (rawServerSettings as { sessionPinnedOrder?: unknown } | null)?.sessionPinnedOrder,
            ))
        && currentSettings.sessionPinnedOrder.length > 0) {
        baseSettings = { ...baseSettings, sessionPinnedOrder: currentSettings.sessionPinnedOrder };
    }

    return Object.keys(pendingSettings).length > 0
        ? applySettings(baseSettings, pendingSettings)
        : baseSettings;
}

export function settingsToSyncPayload(settings: Settings): Partial<Settings> {
    const result: Partial<Settings> = { ...settings };
    if (settings.sidebarOrganizationRaw !== null) {
        result.sidebarOrganization = serializeSidebarOrganizationWithRaw(
            settings.sidebarOrganization,
            settings.sidebarOrganizationRaw,
        ) as Settings['sidebarOrganization'];
    }
    delete result.sidebarOrganizationRaw;
    if (settings.sessionPinnedOrderRaw !== null) {
        result.sessionPinnedOrder = settings.sessionPinnedOrderRaw as Settings['sessionPinnedOrder'];
    }
    delete result.sessionPinnedOrderRaw;
    const compactAgentOverrides = Object.fromEntries(
        Object.entries(settings.agentDefaultOverrides ?? {}).filter(([, value]) => (
            value && typeof value === 'object' && Object.keys(value).length > 0
        )),
    ) as Settings['agentDefaultOverrides'];
    if (Object.keys(compactAgentOverrides).length === 0) {
        delete result.agentDefaultOverrides;
    } else {
        result.agentDefaultOverrides = compactAgentOverrides;
    }
    return result;
}
