import * as z from 'zod';

//
// Configuration Profile Schema (for environment variable profiles)
//

// Environment variable schemas for different AI providers
const AnthropicConfigSchema = z.object({
    baseUrl: z.string().url().optional(),
    authToken: z.string().optional(),
    model: z.string().optional(),
});

const OpenAIConfigSchema = z.object({
    apiKey: z.string().optional(),
    baseUrl: z.string().url().optional(),
    model: z.string().optional(),
});

const AzureOpenAIConfigSchema = z.object({
    apiKey: z.string().optional(),
    endpoint: z.string().url().optional(),
    apiVersion: z.string().optional(),
    deploymentName: z.string().optional(),
});

const TogetherAIConfigSchema = z.object({
    apiKey: z.string().optional(),
    model: z.string().optional(),
});

// Tmux configuration schema
const TmuxConfigSchema = z.object({
    sessionName: z.string().optional(),
    tmpDir: z.string().optional(),
    updateEnvironment: z.boolean().optional(),
});

// Environment variables schema with validation
const EnvironmentVariableSchema = z.object({
    name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'Invalid environment variable name'),
    value: z.string(),
});

// Profile compatibility schema
const ProfileCompatibilitySchema = z.object({
    claude: z.boolean().default(true),
    codex: z.boolean().default(true),
});

export const AIBackendProfileSchema = z.object({
    id: z.string().uuid(),
    name: z.string().min(1).max(100),
    description: z.string().max(500).optional(),

    // Agent-specific configurations
    anthropicConfig: AnthropicConfigSchema.optional(),
    openaiConfig: OpenAIConfigSchema.optional(),
    azureOpenAIConfig: AzureOpenAIConfigSchema.optional(),
    togetherAIConfig: TogetherAIConfigSchema.optional(),

    // Tmux configuration
    tmuxConfig: TmuxConfigSchema.optional(),

    // Environment variables (validated)
    environmentVariables: z.array(EnvironmentVariableSchema).default([]),

    // Compatibility metadata
    compatibility: ProfileCompatibilitySchema.default({ claude: true, codex: true }),

    // Built-in profile indicator
    isBuiltIn: z.boolean().default(false),

    // Metadata
    createdAt: z.number().default(() => Date.now()),
    updatedAt: z.number().default(() => Date.now()),
    version: z.string().default('1.0.0'),
});

export type AIBackendProfile = z.infer<typeof AIBackendProfileSchema>;

// Helper functions for profile validation and compatibility
export function validateProfileForAgent(profile: AIBackendProfile, agent: 'claude' | 'codex'): boolean {
    return profile.compatibility[agent];
}

export function getProfileEnvironmentVariables(profile: AIBackendProfile): Record<string, string> {
    const envVars: Record<string, string> = {};

    // Add validated environment variables
    profile.environmentVariables.forEach(envVar => {
        envVars[envVar.name] = envVar.value;
    });

    // Add Anthropic config
    if (profile.anthropicConfig) {
        if (profile.anthropicConfig.baseUrl) envVars.ANTHROPIC_BASE_URL = profile.anthropicConfig.baseUrl;
        if (profile.anthropicConfig.authToken) envVars.ANTHROPIC_AUTH_TOKEN = profile.anthropicConfig.authToken;
        if (profile.anthropicConfig.model) envVars.ANTHROPIC_MODEL = profile.anthropicConfig.model;
    }

    // Add OpenAI config
    if (profile.openaiConfig) {
        if (profile.openaiConfig.apiKey) envVars.OPENAI_API_KEY = profile.openaiConfig.apiKey;
        if (profile.openaiConfig.baseUrl) envVars.OPENAI_BASE_URL = profile.openaiConfig.baseUrl;
        if (profile.openaiConfig.model) envVars.OPENAI_MODEL = profile.openaiConfig.model;
    }

    // Add Azure OpenAI config
    if (profile.azureOpenAIConfig) {
        if (profile.azureOpenAIConfig.apiKey) envVars.AZURE_OPENAI_API_KEY = profile.azureOpenAIConfig.apiKey;
        if (profile.azureOpenAIConfig.endpoint) envVars.AZURE_OPENAI_ENDPOINT = profile.azureOpenAIConfig.endpoint;
        if (profile.azureOpenAIConfig.apiVersion) envVars.AZURE_OPENAI_API_VERSION = profile.azureOpenAIConfig.apiVersion;
        if (profile.azureOpenAIConfig.deploymentName) envVars.AZURE_OPENAI_DEPLOYMENT_NAME = profile.azureOpenAIConfig.deploymentName;
    }

    // Add Together AI config
    if (profile.togetherAIConfig) {
        if (profile.togetherAIConfig.apiKey) envVars.TOGETHER_API_KEY = profile.togetherAIConfig.apiKey;
        if (profile.togetherAIConfig.model) envVars.TOGETHER_MODEL = profile.togetherAIConfig.model;
    }

    // Add Tmux config
    if (profile.tmuxConfig) {
        if (profile.tmuxConfig.sessionName) envVars.TMUX_SESSION_NAME = profile.tmuxConfig.sessionName;
        if (profile.tmuxConfig.tmpDir) envVars.TMUX_TMPDIR = profile.tmuxConfig.tmpDir;
        if (profile.tmuxConfig.updateEnvironment !== undefined) {
            envVars.TMUX_UPDATE_ENVIRONMENT = profile.tmuxConfig.updateEnvironment.toString();
        }
    }

    return envVars;
}

// Profile versioning system
export const CURRENT_PROFILE_VERSION = '1.0.0';

// Profile version validation
export function validateProfileVersion(profile: AIBackendProfile): boolean {
    // Simple semver validation for now
    const semverRegex = /^\d+\.\d+\.\d+$/;
    return semverRegex.test(profile.version);
}

// Profile compatibility check for version upgrades
export function isProfileVersionCompatible(profileVersion: string, requiredVersion: string = CURRENT_PROFILE_VERSION): boolean {
    // For now, all 1.x.x versions are compatible
    const [major] = profileVersion.split('.');
    const [requiredMajor] = requiredVersion.split('.');
    return major === requiredMajor;
}

//
// Settings Schema
//

export const SettingsSchema = z.object({
    viewInline: z.boolean().describe('Whether to view inline tool calls'),
    inferenceOpenAIKey: z.string().nullish().describe('OpenAI API key for inference'),
    expandTodos: z.boolean().describe('Whether to expand todo lists'),
    showLineNumbers: z.boolean().describe('Whether to show line numbers in diffs'),
    showLineNumbersInToolViews: z.boolean().describe('Whether to show line numbers in tool view diffs'),
    wrapLinesInDiffs: z.boolean().describe('Whether to wrap long lines in diff views'),
    analyticsOptOut: z.boolean().describe('Whether to opt out of anonymous analytics'),
    experiments: z.boolean().describe('Whether to enable experimental features'),
    alwaysShowContextSize: z.boolean().describe('Always show context size in agent input'),
    avatarStyle: z.string().describe('Avatar display style'),
    showFlavorIcons: z.boolean().describe('Whether to show AI provider icons in avatars'),
    compactSessionView: z.boolean().describe('Whether to use compact view for active sessions'),
    hideInactiveSessions: z.boolean().describe('Hide inactive sessions in the main list'),
    reviewPromptAnswered: z.boolean().describe('Whether the review prompt has been answered'),
    reviewPromptLikedApp: z.boolean().nullish().describe('Whether user liked the app when asked'),
    voiceAssistantLanguage: z.string().nullable().describe('Preferred language for voice assistant (null for auto-detect)'),
    preferredLanguage: z.string().nullable().describe('Preferred UI language (null for auto-detect from device locale)'),
    recentMachinePaths: z.array(z.object({
        machineId: z.string(),
        path: z.string()
    })).describe('Last 10 machine-path combinations, ordered by most recent first'),
    lastUsedAgent: z.string().nullable().describe('Last selected agent type for new sessions'),
    lastUsedPermissionMode: z.string().nullable().describe('Last selected permission mode for new sessions'),
    lastUsedModelMode: z.string().nullable().describe('Last selected model mode for new sessions'),
    // Profile management settings
    profiles: z.array(AIBackendProfileSchema).describe('User-defined profiles for AI backend and environment variables'),
    lastUsedProfile: z.string().nullable().describe('Last selected profile for new sessions'),
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

//
// Defaults
//

export const settingsDefaults: Settings = {
    viewInline: false,
    inferenceOpenAIKey: null,
    expandTodos: true,
    showLineNumbers: true,
    showLineNumbersInToolViews: false,
    wrapLinesInDiffs: false,
    analyticsOptOut: false,
    experiments: false,
    alwaysShowContextSize: false,
    avatarStyle: 'brutalist',
    showFlavorIcons: false,
    compactSessionView: false,
    hideInactiveSessions: false,
    reviewPromptAnswered: false,
    reviewPromptLikedApp: null,
    voiceAssistantLanguage: null,
    preferredLanguage: null,
    recentMachinePaths: [],
    lastUsedAgent: null,
    lastUsedPermissionMode: null,
    lastUsedModelMode: null,
    // Profile management defaults
    profiles: [],
    lastUsedProfile: null,
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

    return { ...settingsDefaults, ...parsed.data, ...unknownFields };
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
