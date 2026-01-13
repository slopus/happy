import * as z from 'zod';
import { dbgSettings, isSettingsSyncDebugEnabled } from './debugSettings';
import { SecretStringSchema } from './secretSettings';
import { pruneSecretBindings } from './secretBindings';

//
// Configuration Profile Schema (for environment variable profiles)
//

// Environment variables schema with validation
const EnvironmentVariableSchema = z.object({
    name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'Invalid environment variable name'),
    value: z.string(),
    // User override:
    // - true: force secret handling in UI (and hint daemon)
    // - false: force non-secret handling in UI (unless daemon enforces)
    // - undefined: auto classification
    isSecret: z.boolean().optional(),
});

const RequiredEnvVarKindSchema = z.enum(['secret', 'config']);

const EnvVarRequirementSchema = z.object({
    name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'Invalid environment variable name'),
    kind: RequiredEnvVarKindSchema.default('secret'),
    // Required=true blocks session creation when unsatisfied.
    // Required=false is “optional” (still useful for vault binding, but does not block).
    required: z.boolean().default(true),
});

const RequiresMachineLoginSchema = z.enum(['codex', 'claude-code', 'gemini-cli']);

// Profile compatibility schema
const ProfileCompatibilitySchema = z.object({
    claude: z.boolean().default(true),
    codex: z.boolean().default(true),
    gemini: z.boolean().default(true),
});

export const AIBackendProfileSchema = z.object({
    // Accept both UUIDs (user profiles) and simple strings (built-in profiles like 'anthropic')
    // The isBuiltIn field distinguishes profile types
    id: z.string().min(1),
    name: z.string().min(1).max(100),
    description: z.string().max(500).optional(),

    // Environment variables (validated)
    environmentVariables: z.array(EnvironmentVariableSchema).default([]),

    // Default session type for this profile
    defaultSessionType: z.enum(['simple', 'worktree']).optional(),

    // Default permission mode for this profile
    defaultPermissionMode: z.enum(PERMISSION_MODES).optional(),

    // Default model mode for this profile
    defaultModelMode: z.string().optional(),

    // Compatibility metadata
    compatibility: ProfileCompatibilitySchema.default({ claude: true, codex: true, gemini: true }),

    // Authentication / requirements metadata (used by UI gating)
    // - machineLogin: profile relies on a machine-local CLI login cache
    authMode: z.enum(['machineLogin']).optional(),

    // For machine-login profiles, specify which CLI must be logged in on the target machine.
    // This is used for UX copy and for optional login-status detection.
    requiresMachineLogin: RequiresMachineLoginSchema.optional(),

    // Explicit environment variable requirements for this profile at runtime.
    // Secret requirements are satisfied by machine env, vault binding, or “enter once”.
    envVarRequirements: z.array(EnvVarRequirementSchema).default([]),

    // Built-in profile indicator
    isBuiltIn: z.boolean().default(false),

    // Metadata
    createdAt: z.number().default(() => Date.now()),
    updatedAt: z.number().default(() => Date.now()),
    version: z.string().default('1.0.0'),
})
    // NOTE: Zod v4 marks `superRefine` as deprecated in favor of `.check(...)`.
    // We use chained `.refine(...)` here to preserve per-field error paths/messages.
    .refine((profile) => {
        return !(profile.requiresMachineLogin && profile.authMode !== 'machineLogin');
    }, {
        path: ['requiresMachineLogin'],
        message: 'requiresMachineLogin may only be set when authMode=machineLogin',
    });

export type AIBackendProfile = z.infer<typeof AIBackendProfileSchema>;

//
// Terminal / tmux settings
//

const TerminalTmuxMachineOverrideSchema = z.object({
    useTmux: z.boolean(),
    sessionName: z.string(),
    isolated: z.boolean(),
    tmpDir: z.string().nullable(),
});

export const SavedSecretSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1).max(100),
    kind: z.enum(['apiKey', 'token', 'password', 'other']).default('apiKey'),
    // Secret-at-rest container:
    // - plaintext is set via `encryptedValue.value` (input only; must not be persisted)
    // - ciphertext persists in `encryptedValue.encryptedValue`
    encryptedValue: SecretStringSchema,
    createdAt: z.number().default(() => Date.now()),
    updatedAt: z.number().default(() => Date.now()),
}).refine((key) => {
    const hasValue = typeof key.encryptedValue.value === 'string' && key.encryptedValue.value.trim().length > 0;
    const hasEnc = Boolean(key.encryptedValue.encryptedValue && typeof key.encryptedValue.encryptedValue.c === 'string' && key.encryptedValue.encryptedValue.c.length > 0);
    return hasValue || hasEnc;
}, {
    path: ['encryptedValue'],
    message: 'Secret must include a value or encrypted value',
});

export type SavedSecret = z.infer<typeof SavedSecretSchema>;

// Helper functions for profile validation and compatibility
export function validateProfileForAgent(profile: AIBackendProfile, agent: 'claude' | 'codex' | 'gemini'): boolean {
    return profile.compatibility[agent];
}

function mergeEnvironmentVariables(
    existing: unknown,
    additions: Record<string, string | undefined>
): Array<{ name: string; value: string }> {
    const map = new Map<string, string>();

    if (Array.isArray(existing)) {
        for (const entry of existing) {
            if (!entry || typeof entry !== 'object') continue;
            const name = (entry as any).name;
            const value = (entry as any).value;
            if (typeof name !== 'string' || typeof value !== 'string') continue;
            map.set(name, value);
        }
    }

    for (const [name, value] of Object.entries(additions)) {
        if (typeof value !== 'string') continue;
        if (!map.has(name)) {
            map.set(name, value);
        }
    }

    return Array.from(map.entries()).map(([name, value]) => ({ name, value }));
}

// NOTE: We intentionally do NOT support legacy provider config objects (e.g. `openaiConfig`).
// Profiles must use `environmentVariables` + `envVarRequirements` only.

/**
 * Converts a profile into environment variables for session spawning.
 *
 * HOW ENVIRONMENT VARIABLES WORK:
 *
 * 1. USER LAUNCHES DAEMON with credentials in environment:
 *    Example: Z_AI_AUTH_TOKEN=sk-real-key Z_AI_BASE_URL=https://api.z.ai happy daemon start
 *
 * 2. PROFILE DEFINES MAPPINGS using ${VAR} syntax to map daemon env vars to what CLI expects:
 *    Z.AI example: { name: 'ANTHROPIC_AUTH_TOKEN', value: '${Z_AI_AUTH_TOKEN}' }
 *    DeepSeek example: { name: 'ANTHROPIC_BASE_URL', value: '${DEEPSEEK_BASE_URL}' }
 *    This maps provider-specific vars (Z_AI_AUTH_TOKEN, DEEPSEEK_BASE_URL) to CLI vars (ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL)
 *
 * 3. GUI SENDS to daemon: Profile env vars with ${VAR} placeholders unchanged
 *    Sent: ANTHROPIC_AUTH_TOKEN=${Z_AI_AUTH_TOKEN} (literal string with placeholder)
 *
 * 4. DAEMON EXPANDS ${VAR} from its process.env when spawning session:
 *    - Tmux mode: daemon interpolates ${VAR} / ${VAR:-default} / ${VAR:=default} in env values before launching (shells do not expand placeholders inside env values automatically)
 *    - Non-tmux mode: daemon interpolates ${VAR} / ${VAR:-default} / ${VAR:=default} in env values before calling spawn() (Node does not expand placeholders)
 *
 * 5. SESSION RECEIVES actual expanded values:
 *    ANTHROPIC_AUTH_TOKEN=sk-real-key (expanded from daemon's Z_AI_AUTH_TOKEN, not literal ${Z_AI_AUTH_TOKEN})
 *
 * 6. CLAUDE CLI reads ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_MODEL and connects to Z.AI/DeepSeek/etc
 *
 * This design lets users:
 * - Set credentials ONCE when launching daemon (Z_AI_AUTH_TOKEN, DEEPSEEK_AUTH_TOKEN, ANTHROPIC_AUTH_TOKEN)
 * - Create multiple sessions, each with a different backend profile selected
 * - Session 1 can use Z.AI backend, Session 2 can use DeepSeek backend (simultaneously)
 * - Each session uses its selected backend for its entire lifetime (no mid-session switching)
 * - Keep secrets in shell environment, not in GUI/profile storage
 *
 * PRIORITY ORDER when spawning:
 * Final env = { ...daemon.process.env, ...expandedProfileVars, ...authVars }
 * authVars override profile, profile overrides daemon.process.env
 */
export function getProfileEnvironmentVariables(profile: AIBackendProfile): Record<string, string> {
    const envVars: Record<string, string> = {};

    // Add validated environment variables
    profile.environmentVariables.forEach(envVar => {
        envVars[envVar.name] = envVar.value;
    });

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

// Current schema version for backward compatibility
// NOTE: This schemaVersion is for the Happy app's settings blob (synced via the server).
// happy-cli maintains its own local settings schemaVersion separately.
export const SUPPORTED_SCHEMA_VERSION = 2;

export const SettingsSchema = z.object({
    // Schema version for compatibility detection
    schemaVersion: z.number().default(SUPPORTED_SCHEMA_VERSION).describe('Settings schema version for compatibility checks'),

    viewInline: z.boolean().describe('Whether to view inline tool calls'),
    inferenceOpenAIKey: z.string().nullish().describe('OpenAI API key for inference'),
    expandTodos: z.boolean().describe('Whether to expand todo lists'),
    showLineNumbers: z.boolean().describe('Whether to show line numbers in diffs'),
    showLineNumbersInToolViews: z.boolean().describe('Whether to show line numbers in tool view diffs'),
    wrapLinesInDiffs: z.boolean().describe('Whether to wrap long lines in diff views'),
    analyticsOptOut: z.boolean().describe('Whether to opt out of anonymous analytics'),
    experiments: z.boolean().describe('Whether to enable experimental features'),
    // Per-experiment toggles (gated by `experiments` master switch in UI/usage)
    expGemini: z.boolean().describe('Experimental: enable Gemini backend + Gemini-related UX'),
    expUsageReporting: z.boolean().describe('Experimental: enable usage reporting UI'),
    expFileViewer: z.boolean().describe('Experimental: enable session file viewer'),
    expShowThinkingMessages: z.boolean().describe('Experimental: show assistant thinking messages'),
    expSessionType: z.boolean().describe('Experimental: show session type selector (simple vs worktree)'),
    expZen: z.boolean().describe('Experimental: enable Zen navigation/experience'),
    expVoiceAuthFlow: z.boolean().describe('Experimental: enable authenticated voice token flow'),
    useProfiles: z.boolean().describe('Whether to enable AI backend profiles feature'),
    useEnhancedSessionWizard: z.boolean().describe('A/B test flag: Use enhanced profile-based session wizard UI'),
    terminalUseTmux: z.boolean().describe('Whether new sessions should start in tmux by default'),
    terminalTmuxSessionName: z.string().describe('Default tmux session name for new sessions'),
    terminalTmuxIsolated: z.boolean().describe('Whether to use an isolated tmux server for new sessions'),
    terminalTmuxTmpDir: z.string().nullable().describe('Optional TMUX_TMPDIR override for isolated tmux server'),
    terminalTmuxByMachineId: z.record(z.string(), TerminalTmuxMachineOverrideSchema).default({}).describe('Per-machine overrides for tmux session spawning'),
    // Legacy combined toggle (kept for backward compatibility; see settingsParse migration)
    usePickerSearch: z.boolean().describe('Whether to show search in machine/path picker UIs (legacy combined toggle)'),
    useMachinePickerSearch: z.boolean().describe('Whether to show search in machine picker UIs'),
    usePathPickerSearch: z.boolean().describe('Whether to show search in path picker UIs'),
    alwaysShowContextSize: z.boolean().describe('Always show context size in agent input'),
    agentInputEnterToSend: z.boolean().describe('Whether pressing Enter submits/sends in the agent input (web)'),
    agentInputActionBarLayout: z.enum(['auto', 'wrap', 'scroll', 'collapsed']).describe('Agent input action bar layout'),
    agentInputChipDensity: z.enum(['auto', 'labels', 'icons']).describe('Agent input action chip density'),
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
    secrets: z.array(SavedSecretSchema).default([]).describe('Saved secrets (encrypted settings). Values are never re-displayed in UI.'),
    secretBindingsByProfileId: z.record(z.string(), z.record(z.string(), z.string())).default({}).describe('Default saved secret ID per profile and env var name'),
    // Favorite directories for quick path selection
    favoriteDirectories: z.array(z.string()).describe('User-defined favorite directories for quick access in path selection'),
    // Favorite machines for quick machine selection
    favoriteMachines: z.array(z.string()).describe('User-defined favorite machines (machine IDs) for quick access in machine selection'),
    // Favorite profiles for quick profile selection (built-in or custom profile IDs)
    favoriteProfiles: z.array(z.string()).describe('User-defined favorite profiles (profile IDs) for quick access in profile selection'),
    // Dismissed CLI warning banners (supports both per-machine and global dismissal)
    dismissedCLIWarnings: z.object({
        perMachine: z.record(z.string(), z.object({
            claude: z.boolean().optional(),
            codex: z.boolean().optional(),
            gemini: z.boolean().optional(),
        })).default({}),
        global: z.object({
            claude: z.boolean().optional(),
            codex: z.boolean().optional(),
            gemini: z.boolean().optional(),
        }).default({}),
    }).default({ perMachine: {}, global: {} }).describe('Tracks which CLI installation warnings user has dismissed (per-machine or globally)'),
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
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    viewInline: false,
    inferenceOpenAIKey: null,
    expandTodos: true,
    showLineNumbers: true,
    showLineNumbersInToolViews: false,
    wrapLinesInDiffs: false,
    analyticsOptOut: false,
    experiments: false,
    expGemini: false,
    expUsageReporting: false,
    expFileViewer: false,
    expShowThinkingMessages: false,
    expSessionType: false,
    expZen: false,
    expVoiceAuthFlow: false,
    useProfiles: false,
    terminalUseTmux: false,
    terminalTmuxSessionName: 'happy',
    terminalTmuxIsolated: true,
    terminalTmuxTmpDir: null,
    terminalTmuxByMachineId: {},
    useEnhancedSessionWizard: false,
    usePickerSearch: false,
    useMachinePickerSearch: false,
    usePathPickerSearch: false,
    alwaysShowContextSize: false,
    agentInputEnterToSend: true,
    agentInputActionBarLayout: 'auto',
    agentInputChipDensity: 'auto',
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
    secrets: [],
    secretBindingsByProfileId: {},
    // Favorite directories (empty by default)
    favoriteDirectories: [],
    // Favorite machines (empty by default)
    favoriteMachines: [],
    // Favorite profiles (empty by default)
    favoriteProfiles: [],
    // Dismissed CLI warnings (empty by default)
    dismissedCLIWarnings: { perMachine: {}, global: {} },
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

    const isDev = typeof __DEV__ !== 'undefined' && __DEV__;
    const debug = isSettingsSyncDebugEnabled();

    // IMPORTANT: be tolerant of partially-invalid settings objects.
    // A single invalid field (e.g. one malformed profile) must not reset all other known settings to defaults.
    const input = settings as Record<string, unknown>;
    const result: any = { ...settingsDefaults };

    // Parse known fields individually to avoid whole-object failure.
    (Object.keys(SettingsSchema.shape) as Array<keyof typeof SettingsSchema.shape>).forEach((key) => {
        if (!Object.prototype.hasOwnProperty.call(input, key)) return;

        // Special-case profiles: validate per profile entry, keep valid ones.
        if (key === 'profiles') {
            const profilesValue = input[key];
            if (Array.isArray(profilesValue)) {
                const parsedProfiles: AIBackendProfile[] = [];
                for (const rawProfile of profilesValue) {
                    const parsedProfile = AIBackendProfileSchema.safeParse(rawProfile);
                    if (parsedProfile.success) {
                        parsedProfiles.push(parsedProfile.data);
                    } else if (isDev) {
                        console.warn('[settingsParse] Dropping invalid profile entry', parsedProfile.error.issues);
                    }
                }
                result.profiles = parsedProfiles;
            }
            return;
        }

        // Special-case secrets: validate per secret entry, keep valid ones.
        if (key === 'secrets') {
            const secretsValue = input[key];
            if (Array.isArray(secretsValue)) {
                const parsedSecrets: SavedSecret[] = [];
                for (const rawSecret of secretsValue) {
                    const parsedSecret = SavedSecretSchema.safeParse(rawSecret);
                    if (parsedSecret.success) {
                        parsedSecrets.push(parsedSecret.data);
                    } else if (isDev || debug) {
                        console.warn('[settingsParse] Dropping invalid secret entry', parsedSecret.error.issues);
                    }
                }
                result.secrets = parsedSecrets;
            }
            return;
        }

        const schema = SettingsSchema.shape[key];
        const parsedField = schema.safeParse(input[key]);
        if (parsedField.success) {
            result[key] = parsedField.data;
        } else if (isDev || debug) {
            console.warn(`[settingsParse] Invalid settings field "${String(key)}" - using default`, parsedField.error.issues);
            if (debug) {
                dbgSettings('settingsParse: invalid field', {
                    key: String(key),
                    issues: parsedField.error.issues.map((i) => ({
                        path: i.path,
                        code: i.code,
                        message: i.message,
                    })),
                });
            }
        }
    });

    // Migration: Convert old 'zh' language code to 'zh-Hans'
    if (result.preferredLanguage === 'zh') {
        result.preferredLanguage = 'zh-Hans';
    }

    // Migration: Convert legacy combined picker-search toggle into per-picker toggles.
    // Only apply if new fields were not present in persisted settings.
    const hasMachineSearch = 'useMachinePickerSearch' in input;
    const hasPathSearch = 'usePathPickerSearch' in input;
    if (!hasMachineSearch && !hasPathSearch) {
        const legacy = SettingsSchema.shape.usePickerSearch.safeParse(input.usePickerSearch);
        if (legacy.success && legacy.data === true) {
            result.useMachinePickerSearch = true;
            result.usePathPickerSearch = true;
        }
    }

    // Migration: Introduce per-experiment toggles.
    // If persisted settings only had `experiments` (older clients), default ALL experiment toggles
    // to match the master switch so existing users keep the same behavior.
    const experimentKeys = [
        'expGemini',
        'expUsageReporting',
        'expFileViewer',
        'expShowThinkingMessages',
        'expSessionType',
        'expZen',
        'expVoiceAuthFlow',
    ] as const;
    const hasAnyExperimentKey = experimentKeys.some((k) => k in input);
    if (!hasAnyExperimentKey) {
        const enableAll = result.experiments === true;
        for (const key of experimentKeys) {
            result[key] = enableAll;
        }
    }

    // Preserve unknown fields (forward compatibility).
    for (const [key, value] of Object.entries(input)) {
        if (key === '__proto__') continue;
        if (!Object.prototype.hasOwnProperty.call(SettingsSchema.shape, key)) {
            Object.defineProperty(result, key, {
                value,
                enumerable: true,
                configurable: true,
                writable: true,
            });
        }
    }

    return pruneSecretBindings(result as Settings);
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

    return pruneSecretBindings(result as Settings);
}
