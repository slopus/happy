import { MMKV } from 'react-native-mmkv';
import { Settings, settingsDefaults, settingsParse, SettingsSchema } from './settings';
import { LocalSettings, localSettingsDefaults, localSettingsParse } from './localSettings';
import { Purchases, purchasesDefaults, purchasesParse } from './purchases';
import { Profile, profileDefaults, profileParse } from './profile';
import { isModelMode, isPermissionMode, type PermissionMode, type ModelMode } from '@/sync/permissionTypes';
import { DEFAULT_AGENT_ID, isAgentId, type AgentId } from '@/agents/catalog';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/storageScope';
import { dbgSettings, summarizeSettingsDelta } from './debugSettings';
import { SecretStringSchema, type SecretString } from './secretSettings';

const isWebRuntime = typeof window !== 'undefined' && typeof document !== 'undefined';
const storageScope = isWebRuntime ? null : readStorageScopeFromEnv();
const mmkv = storageScope ? new MMKV({ id: scopedStorageId('default', storageScope) }) : new MMKV();
const NEW_SESSION_DRAFT_KEY = 'new-session-draft-v1';

export type NewSessionSessionType = 'simple' | 'worktree';
export type NewSessionAgentType = AgentId;

export interface NewSessionDraft {
    input: string;
    selectedMachineId: string | null;
    selectedPath: string | null;
    selectedProfileId: string | null;
    selectedSecretId: string | null;
    /**
     * Per-profile per-env-var secret selection (saved secret id or '' for "use machine env").
     * Used by the New Session wizard to preserve overrides while switching profiles.
     */
    selectedSecretIdByProfileIdByEnvVarName?: Record<string, Record<string, string | null | undefined>> | null;
    /**
     * Per-profile per-env-var session-only secret values, encrypted-at-rest.
     * (These are decrypted only when needed by the wizard.)
     */
    sessionOnlySecretValueEncByProfileIdByEnvVarName?: Record<string, Record<string, SecretString | null | undefined>> | null;
    agentType: NewSessionAgentType;
    permissionMode: PermissionMode;
    modelMode: ModelMode;
    sessionType: NewSessionSessionType;
    resumeSessionId?: string;
    /**
     * Provider-specific new-session option state keyed by agent id.
     * This is UI-only draft state (not sent to server).
     */
    agentNewSessionOptionStateByAgentId?: Partial<Record<AgentId, Record<string, unknown>>> | null;
    updatedAt: number;
}

type DraftNestedRecord<T> = Record<string, Record<string, T | null>>;

/**
 * Parse a "record of records" draft field while salvaging valid entries.
 * We intentionally accept partial validity to avoid dropping all draft state
 * due to a single malformed nested entry.
 */
function parseDraftNestedRecord<T>(
    input: unknown,
    parseValue: (value: unknown) => T | null | undefined
): DraftNestedRecord<T> | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const out: DraftNestedRecord<T> = {};

    for (const [rawProfileId, byEnv] of Object.entries(input as Record<string, unknown>)) {
        const profileId = typeof rawProfileId === 'string' ? rawProfileId.trim() : '';
        if (!profileId) continue;
        if (!byEnv || typeof byEnv !== 'object' || Array.isArray(byEnv)) continue;

        const inner: Record<string, T | null> = {};
        for (const [rawEnvVarName, rawValue] of Object.entries(byEnv as Record<string, unknown>)) {
            const envVarName = typeof rawEnvVarName === 'string' ? rawEnvVarName.trim().toUpperCase() : '';
            if (!envVarName) continue;

            const parsed = parseValue(rawValue);
            if (parsed !== undefined) {
                inner[envVarName] = parsed;
            }
        }

        if (Object.keys(inner).length > 0) out[profileId] = inner;
    }

    return Object.keys(out).length > 0 ? out : null;
}

function parseDraftStringOrNull(value: unknown): string | null | undefined {
    if (value === null) return null;
    if (typeof value === 'string') return value;
    return undefined;
}

function parseDraftSecretStringOrNull(value: unknown): SecretString | null | undefined {
    if (value === null) return null;
    const parsed = SecretStringSchema.safeParse(value);
    if (parsed.success) return parsed.data;
    return undefined;
}

function parseDraftAgentNewSessionOptionStateByAgentId(
    input: unknown,
): Partial<Record<AgentId, Record<string, unknown>>> | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const out: Partial<Record<AgentId, Record<string, unknown>>> = {};

    for (const [rawAgentId, rawOptions] of Object.entries(input as Record<string, unknown>)) {
        if (!isAgentId(rawAgentId)) continue;
        if (!rawOptions || typeof rawOptions !== 'object' || Array.isArray(rawOptions)) continue;

        const options: Record<string, unknown> = {};
        for (const [rawKey, rawValue] of Object.entries(rawOptions as Record<string, unknown>)) {
            const key = typeof rawKey === 'string' ? rawKey.trim() : '';
            if (!key) continue;

            // Only salvage JSON-safe primitives; objects can be added later if needed.
            if (rawValue === null || typeof rawValue === 'boolean' || typeof rawValue === 'number' || typeof rawValue === 'string') {
                options[key] = rawValue;
            }
        }

        if (Object.keys(options).length > 0) out[rawAgentId] = options;
    }

    return Object.keys(out).length > 0 ? out : null;
}

export function loadSettings(): { settings: Settings, version: number | null } {
    const settings = mmkv.getString('settings');
    if (settings) {
        try {
            const parsed = JSON.parse(settings);
            const version = typeof parsed.version === 'number' ? parsed.version : null;
            return { settings: settingsParse(parsed.settings), version };
        } catch (e) {
            console.error('Failed to parse settings', e);
            return { settings: { ...settingsDefaults }, version: null };
        }
    }
    return { settings: { ...settingsDefaults }, version: null };
}

export function saveSettings(settings: Settings, version: number) {
    mmkv.set('settings', JSON.stringify({ settings, version }));
}

function parsePendingSettings(raw: unknown): Partial<Settings> {
    // CRITICAL: Pending settings must represent ONLY user-intended deltas.
    // We must NOT apply schema defaults here (otherwise `{}` becomes a non-empty delta,
    // causing a POST on every startup and potentially overwriting server settings).
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return {};
    }
    const input = raw as Record<string, unknown>;
    const out: Partial<Settings> = {};

    (Object.keys(SettingsSchema.shape) as Array<keyof typeof SettingsSchema.shape>).forEach((key) => {
        if (!Object.prototype.hasOwnProperty.call(input, key)) return;
        const schema = SettingsSchema.shape[key];
        const parsed = schema.safeParse(input[key]);
        if (parsed.success) {
            (out as any)[key] = parsed.data;
        }
    });

    return out;
}

export function loadPendingSettings(): Partial<Settings> {
    const pending = mmkv.getString('pending-settings');
    if (pending) {
        try {
            const parsed = JSON.parse(pending);
            const validated = parsePendingSettings(parsed);
            dbgSettings('loadPendingSettings', {
                pendingKeys: Object.keys(validated).sort(),
                pendingSummary: summarizeSettingsDelta(validated),
            });
            return validated;
        } catch (e) {
            console.error('Failed to parse pending settings', e);
            return {};
        }
    }
    dbgSettings('loadPendingSettings: none', {});
    return {};
}

export function savePendingSettings(settings: Partial<Settings>) {
    // Recommended: delete key when empty to reduce churn/ambiguity.
    if (Object.keys(settings).length === 0) {
        mmkv.delete('pending-settings');
    } else {
        mmkv.set('pending-settings', JSON.stringify(settings));
    }
    dbgSettings('savePendingSettings', {
        pendingKeys: Object.keys(settings).sort(),
        pendingSummary: summarizeSettingsDelta(settings),
    });
}

export function loadLocalSettings(): LocalSettings {
    const localSettings = mmkv.getString('local-settings');
    if (localSettings) {
        try {
            const parsed = JSON.parse(localSettings);
            return localSettingsParse(parsed);
        } catch (e) {
            console.error('Failed to parse local settings', e);
            return { ...localSettingsDefaults };
        }
    }
    return { ...localSettingsDefaults };
}

export function saveLocalSettings(settings: LocalSettings) {
    mmkv.set('local-settings', JSON.stringify(settings));
}

export function loadThemePreference(): 'light' | 'dark' | 'adaptive' {
    const localSettings = mmkv.getString('local-settings');
    if (localSettings) {
        try {
            const parsed = JSON.parse(localSettings);
            const settings = localSettingsParse(parsed);
            return settings.themePreference;
        } catch (e) {
            console.error('Failed to parse local settings for theme preference', e);
            return localSettingsDefaults.themePreference;
        }
    }
    return localSettingsDefaults.themePreference;
}

export function loadPurchases(): Purchases {
    const purchases = mmkv.getString('purchases');
    if (purchases) {
        try {
            const parsed = JSON.parse(purchases);
            return purchasesParse(parsed);
        } catch (e) {
            console.error('Failed to parse purchases', e);
            return { ...purchasesDefaults };
        }
    }
    return { ...purchasesDefaults };
}

export function savePurchases(purchases: Purchases) {
    mmkv.set('purchases', JSON.stringify(purchases));
}

export function loadSessionDrafts(): Record<string, string> {
    const drafts = mmkv.getString('session-drafts');
    if (drafts) {
        try {
            return JSON.parse(drafts);
        } catch (e) {
            console.error('Failed to parse session drafts', e);
            return {};
        }
    }
    return {};
}

export function saveSessionDrafts(drafts: Record<string, string>) {
    mmkv.set('session-drafts', JSON.stringify(drafts));
}

export function loadNewSessionDraft(): NewSessionDraft | null {
    const raw = mmkv.getString(NEW_SESSION_DRAFT_KEY);
    if (!raw) {
        return null;
    }
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') {
            return null;
        }

        const input = typeof parsed.input === 'string' ? parsed.input : '';
        const selectedMachineId = typeof parsed.selectedMachineId === 'string' ? parsed.selectedMachineId : null;
        const selectedPath = typeof parsed.selectedPath === 'string' ? parsed.selectedPath : null;
        const selectedProfileId = typeof parsed.selectedProfileId === 'string' ? parsed.selectedProfileId : null;
        const selectedSecretId = typeof parsed.selectedSecretId === 'string' ? parsed.selectedSecretId : null;
        const selectedSecretIdByProfileIdByEnvVarName = parseDraftNestedRecord(
            parsed.selectedSecretIdByProfileIdByEnvVarName,
            parseDraftStringOrNull,
        );
        const sessionOnlySecretValueEncByProfileIdByEnvVarName = parseDraftNestedRecord(
            parsed.sessionOnlySecretValueEncByProfileIdByEnvVarName,
            parseDraftSecretStringOrNull,
        );
        const agentType: NewSessionAgentType = isAgentId(parsed.agentType) ? parsed.agentType : DEFAULT_AGENT_ID;
        const permissionMode: PermissionMode = isPermissionMode(parsed.permissionMode)
            ? parsed.permissionMode
            : 'default';
        const modelMode: ModelMode = isModelMode(parsed.modelMode)
            ? parsed.modelMode
            : 'default';
        const sessionType: NewSessionSessionType = parsed.sessionType === 'worktree' ? 'worktree' : 'simple';
        const resumeSessionId = typeof parsed.resumeSessionId === 'string' ? parsed.resumeSessionId : undefined;
        const agentNewSessionOptionStateByAgentId = parseDraftAgentNewSessionOptionStateByAgentId(
            (parsed as any).agentNewSessionOptionStateByAgentId,
        );
        const legacyAuggieAllowIndexing = typeof (parsed as any).auggieAllowIndexing === 'boolean'
            ? (parsed as any).auggieAllowIndexing
            : undefined;
        const updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now();

        const migratedAgentOptions: Partial<Record<AgentId, Record<string, unknown>>> = {
            ...(agentNewSessionOptionStateByAgentId ?? {}),
        };
        // Legacy migration: older drafts stored `auggieAllowIndexing` at top-level.
        // Keep reading it so users don't lose their local draft state.
        if (typeof legacyAuggieAllowIndexing === 'boolean') {
            migratedAgentOptions.auggie = {
                ...(migratedAgentOptions.auggie ?? {}),
                allowIndexing: legacyAuggieAllowIndexing,
            };
        }

        return {
            input,
            selectedMachineId,
            selectedPath,
            selectedProfileId,
            selectedSecretId,
            selectedSecretIdByProfileIdByEnvVarName,
            sessionOnlySecretValueEncByProfileIdByEnvVarName,
            agentType,
            permissionMode,
            modelMode,
            sessionType,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            ...(Object.keys(migratedAgentOptions).length > 0 ? { agentNewSessionOptionStateByAgentId: migratedAgentOptions } : {}),
            updatedAt,
        };
    } catch (e) {
        console.error('Failed to parse new session draft', e);
        return null;
    }
}

export function saveNewSessionDraft(draft: NewSessionDraft) {
    mmkv.set(NEW_SESSION_DRAFT_KEY, JSON.stringify(draft));
}

export function clearNewSessionDraft() {
    mmkv.delete(NEW_SESSION_DRAFT_KEY);
}

export function loadSessionPermissionModes(): Record<string, PermissionMode> {
    const modes = mmkv.getString('session-permission-modes');
    if (modes) {
        try {
            return JSON.parse(modes);
        } catch (e) {
            console.error('Failed to parse session permission modes', e);
            return {};
        }
    }
    return {};
}

export function saveSessionPermissionModes(modes: Record<string, PermissionMode>) {
    mmkv.set('session-permission-modes', JSON.stringify(modes));
}

export function loadSessionPermissionModeUpdatedAts(): Record<string, number> {
    const raw = mmkv.getString('session-permission-mode-updated-ats');
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return {};
            }

            const result: Record<string, number> = {};
            for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
                if (typeof value === 'number' && Number.isFinite(value)) {
                    result[sessionId] = value;
                }
            }
            return result;
        } catch (e) {
            console.error('Failed to parse session permission mode updated timestamps', e);
            return {};
        }
    }
    return {};
}

export function saveSessionPermissionModeUpdatedAts(updatedAts: Record<string, number>) {
    mmkv.set('session-permission-mode-updated-ats', JSON.stringify(updatedAts));
}

export function loadSessionLastViewed(): Record<string, number> {
    const raw = mmkv.getString('session-last-viewed');
    if (raw) {
        try {
            const parsed: unknown = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return {};
            }

            const result: Record<string, number> = {};
            for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
                if (typeof value === 'number' && Number.isFinite(value)) {
                    result[sessionId] = value;
                }
            }
            return result;
        } catch (e) {
            console.error('Failed to parse session last viewed timestamps', e);
            return {};
        }
    }
    return {};
}

export function saveSessionLastViewed(data: Record<string, number>) {
    mmkv.set('session-last-viewed', JSON.stringify(data));
}

export function loadSessionModelModes(): Record<string, ModelMode> {
    const modes = mmkv.getString('session-model-modes');
    if (modes) {
        try {
            const parsed: unknown = JSON.parse(modes);
            if (!parsed || typeof parsed !== 'object') {
                return {};
            }

            const result: Record<string, ModelMode> = {};
            Object.entries(parsed as Record<string, unknown>).forEach(([sessionId, mode]) => {
                if (isModelMode(mode)) {
                    result[sessionId] = mode;
                }
            });
            return result;
        } catch (e) {
            console.error('Failed to parse session model modes', e);
            return {};
        }
    }
    return {};
}

export function saveSessionModelModes(modes: Record<string, ModelMode>) {
    mmkv.set('session-model-modes', JSON.stringify(modes));
}

export function loadProfile(): Profile {
    const profile = mmkv.getString('profile');
    if (profile) {
        try {
            const parsed = JSON.parse(profile);
            return profileParse(parsed);
        } catch (e) {
            console.error('Failed to parse profile', e);
            return { ...profileDefaults };
        }
    }
    return { ...profileDefaults };
}

export function saveProfile(profile: Profile) {
    mmkv.set('profile', JSON.stringify(profile));
}

// Simple temporary text storage for passing large strings between screens
export function storeTempText(content: string): string {
    const id = `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    mmkv.set(`temp_text_${id}`, content);
    return id;
}

export function retrieveTempText(id: string): string | null {
    const content = mmkv.getString(`temp_text_${id}`);
    if (content) {
        // Auto-delete after retrieval
        mmkv.delete(`temp_text_${id}`);
        return content;
    }
    return null;
}

export function clearPersistence() {
    mmkv.clearAll();
}
