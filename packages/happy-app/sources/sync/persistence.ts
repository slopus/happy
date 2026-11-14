import { ArtifactRequests } from '@slopus/happy-wire';
import { MMKV } from 'react-native-mmkv';
import { accountStorageId } from '@/auth/accountRuntime';
import { clearComposeDraft } from './composeDraft';
import { Settings, settingsDefaults, settingsParse, settingsToSyncPayload, SettingsSchema } from './settings';
import { LocalSettings, localSettingsDefaults, localSettingsParse } from './localSettings';
import { Purchases, purchasesDefaults, purchasesParse } from './purchases';
import { Profile, profileDefaults, profileParse } from './profile';
import type { PermissionModeKey } from '@/components/PermissionModeSelector';
import { SidebarOrganizationSchema, type SidebarOrganization } from './sidebarOrganization';
import { clearPublicSessionShareQueueStorage } from './publicSessionShareQueuePersistence';

const storageId = accountStorageId();
const mmkv = storageId ? new MMKV({ id: storageId }) : new MMKV();
const NEW_SESSION_DRAFT_KEY = 'new-session-draft-v1';
const REGISTERED_PUSH_TOKEN_KEY = 'registered-push-token-v1';
const VOICE_SOFT_PAYWALL_SHOWN_KEY = 'voice-soft-paywall-shown';
const VOICE_ONBOARDING_PROMPT_LOAD_COUNT_KEY = 'voice-onboarding-prompt-load-count';
const VOICE_MESSAGE_COUNT_KEY = 'voice-message-count';
const SESSION_MANAGEMENT_KEY = 'session-management-v1';
const PENDING_SIDEBAR_ORGANIZATION_BASE_KEY = 'pending-sidebar-organization-base-v1';
const PENDING_SESSION_PINNED_ORDER_BASE_KEY = 'pending-session-pinned-order-base-v1';
const PENDING_SESSION_PINNED_STATE_KEY = 'pending-session-pinned-state-v1';
const STAGING_DREAMSKIN_SEEDED_KEY = 'staging-dreamskin-seeded-v1';

export type NewSessionAgentType = 'ask' | 'claude' | 'codex' | 'gemini' | 'opencode' | 'openclaw';
export type NewSessionSessionType = 'simple' | 'worktree';

export interface NewSessionDraft {
    input: string;
    selectedMachineId: string | null;
    selectedPath: string | null;
    agentType: NewSessionAgentType;
    permissionMode: PermissionModeKey;
    modelMode: string;
    effortLevel: string | null;
    fastMode?: boolean;
    sessionType: NewSessionSessionType;
    worktreeKey: string | null;
    updatedAt: number;
}

export interface SessionManagementPreferences {
    pinnedOrder: string[];
    focusOrder: string[];
}

/** Shares the account's existing local store and logout cleanup. No file bodies or credentials. */
export function loadProjectWorkspaceCache(): string | undefined { return mmkv.getString('project-workspace-cache-v1'); }
export function saveProjectWorkspaceCache(value: string): void { mmkv.set('project-workspace-cache-v1', value); }
/** Authoritative deletions outlive expiring history caches and runtime generations. */
export function loadProjectSessionDeleted(key: string): boolean { return mmkv.getBoolean(`project-session-deleted-v1:${key}`) === true; }
export function saveProjectSessionDeleted(key: string): void { mmkv.set(`project-session-deleted-v1:${key}`, true); }

/** Project organization is a durable preference, separate from the expiring archive cache. */
export function loadProjectLibraryPreferences(): string | undefined { return mmkv.getString('project-library-v1'); }
export function saveProjectLibraryPreferences(value: string): void { mmkv.set('project-library-v1', value); }

export function loadSettings(): { settings: Settings, version: number | null } {
    const settings = mmkv.getString('settings');
    if (settings) {
        try {
            const parsed = JSON.parse(settings);
            return { settings: settingsParse(parsed.settings), version: parsed.version };
        } catch (e) {
            console.error('Failed to parse settings', e);
            return { settings: { ...settingsDefaults }, version: null };
        }
    }
    return { settings: { ...settingsDefaults }, version: null };
}

export function saveSettings(settings: Settings, version: number) {
    mmkv.set('settings', JSON.stringify({ settings: settingsToSyncPayload(settings), version }));
}

export function loadPendingSettings(): Partial<Settings> {
    const pending = mmkv.getString('pending-settings');
    if (pending) {
        try {
            const parsed = JSON.parse(pending);
            return SettingsSchema.partial().parse(parsed);
        } catch (e) {
            console.error('Failed to parse pending settings', e);
            return {};
        }
    }
    return {};
}

export function savePendingSettings(settings: Partial<Settings>) {
    mmkv.set('pending-settings', JSON.stringify(settings));
}

export type PendingSessionPinnedState = {
    value: string[];
    base: string[];
    clearRaw: true;
};

export function recoverPendingSettingsWithPinnedState(
    pending: Partial<Settings>,
    pinnedState: PendingSessionPinnedState | null,
): Partial<Settings> {
    if (pinnedState) {
        return {
            ...pending,
            sessionPinnedOrder: pinnedState.value,
            sessionPinnedOrderRaw: null,
        };
    }

    // Both fields belong to the same atomic intent. If its state record is
    // absent (for example after an ACK), neither mirrored field is recoverable.
    const {
        sessionPinnedOrder: _unsafeUnpairedPinIntent,
        sessionPinnedOrderRaw: _unsafeUnpairedRawReset,
        ...safePending
    } = pending;
    return safePending;
}

function parsePinnedOrder(value: unknown): string[] | null {
    return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0)
        ? Array.from(new Set(value))
        : null;
}

/**
 * Loads the pending pin value and its three-way merge base from one MMKV record.
 * The legacy two-record fallback is only for builds produced during migration.
 */
export function loadPendingSessionPinnedState(): PendingSessionPinnedState | null {
    const value = mmkv.getString(PENDING_SESSION_PINNED_STATE_KEY);
    if (value) {
        try {
            const parsed = JSON.parse(value) as { value?: unknown; base?: unknown };
            const pendingValue = parsePinnedOrder(parsed.value);
            const base = parsePinnedOrder(parsed.base);
            return pendingValue && base ? { value: pendingValue, base, clearRaw: true } : null;
        } catch {
            return null;
        }
    }

    const legacyPending = loadPendingSettings().sessionPinnedOrder;
    const legacyBase = loadPendingSessionPinnedOrderBase();
    return legacyPending && legacyBase
        ? { value: legacyPending, base: legacyBase, clearRaw: true }
        : null;
}

export function savePendingSessionPinnedState(value: PendingSessionPinnedState | null): void {
    if (value) {
        mmkv.set(PENDING_SESSION_PINNED_STATE_KEY, JSON.stringify(value));
    } else {
        mmkv.delete(PENDING_SESSION_PINNED_STATE_KEY);
    }
    // Stop consulting the pre-atomic base after the first v1 state write.
    mmkv.delete(PENDING_SESSION_PINNED_ORDER_BASE_KEY);
}

export function loadPendingSidebarOrganizationBase(): SidebarOrganization | null {
    const value = mmkv.getString(PENDING_SIDEBAR_ORGANIZATION_BASE_KEY);
    if (!value) return null;
    try {
        const parsed = SidebarOrganizationSchema.safeParse(JSON.parse(value));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

export function savePendingSidebarOrganizationBase(value: SidebarOrganization | null): void {
    if (value) {
        mmkv.set(PENDING_SIDEBAR_ORGANIZATION_BASE_KEY, JSON.stringify(value));
    } else {
        mmkv.delete(PENDING_SIDEBAR_ORGANIZATION_BASE_KEY);
    }
}

export function loadPendingSessionPinnedOrderBase(): string[] | null {
    const value = mmkv.getString(PENDING_SESSION_PINNED_ORDER_BASE_KEY);
    if (!value) return null;
    try {
        return parsePinnedOrder(JSON.parse(value));
    } catch {
        return null;
    }
}

function seedStagingDreamSkinOnce(settings: LocalSettings): LocalSettings {
    // Only the independent test-site build sets this flag. Keep the saved
    // preference mutable so switching back to the original skin sticks.
    if (process.env.EXPO_PUBLIC_DREAMSKIN_STAGING_DEFAULT !== '1' || mmkv.getBoolean(STAGING_DREAMSKIN_SEEDED_KEY)) {
        return settings;
    }
    const seeded = { ...settings, desktopSkinId: 'dreamskin' as const };
    mmkv.set('local-settings', JSON.stringify(seeded));
    mmkv.set(STAGING_DREAMSKIN_SEEDED_KEY, true);
    return seeded;
}

export function loadLocalSettings(): LocalSettings {
    const localSettings = mmkv.getString('local-settings');
    if (localSettings) {
        try {
            const parsed = JSON.parse(localSettings);
            return seedStagingDreamSkinOnce(localSettingsParse(parsed));
        } catch (e) {
            console.error('Failed to parse local settings', e);
            return seedStagingDreamSkinOnce({ ...localSettingsDefaults });
        }
    }
    return seedStagingDreamSkinOnce({ ...localSettingsDefaults });
}

export function saveLocalSettings(settings: LocalSettings) {
    const previous = loadLocalSettings().relationshipAdvisorConversations;
    mmkv.set('local-settings', JSON.stringify(settings));
    cleanupRemovedAdvisorImages(previous, settings.relationshipAdvisorConversations);
}

function cleanupRemovedAdvisorImages(previous: LocalSettings['relationshipAdvisorConversations'], next: LocalSettings['relationshipAdvisorConversations']) {
    const retained = new Set(next.flatMap((conversation) => conversation.messages.flatMap((message) => message.imageKeys ?? [])));
    const removed = [...new Set(previous.flatMap((conversation) => conversation.messages.flatMap((message) => message.imageKeys ?? [])))]
        .filter((key) => !retained.has(key));
    if (removed.length) {
        void import('./relationshipAdvisorImageCache').then(({ deleteAdvisorImages }) => deleteAdvisorImages(removed)).catch(() => undefined);
    }
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

export function loadThemePack(): LocalSettings['themePack'] {
    const localSettings = mmkv.getString('local-settings');
    if (localSettings) {
        try {
            const parsed = JSON.parse(localSettings);
            const settings = localSettingsParse(parsed);
            return settings.themePack;
        } catch (e) {
            console.error('Failed to parse local settings for theme pack', e);
            return localSettingsDefaults.themePack;
        }
    }
    return localSettingsDefaults.themePack;
}

export function loadDesktopSkinId(): LocalSettings['desktopSkinId'] {
    return loadLocalSettings().desktopSkinId;
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

        // Keep the stored bytes for recovery, but never restore a retired
        // Personal draft under a different engine's identity.
        if (parsed.agentType === 'personal') return null;
        const input = typeof parsed.input === 'string' ? parsed.input : '';
        const selectedMachineId = typeof parsed.selectedMachineId === 'string' ? parsed.selectedMachineId : null;
        const selectedPath = typeof parsed.selectedPath === 'string' ? parsed.selectedPath : null;
        const agentType: NewSessionAgentType = parsed.agentType === 'ask' || parsed.agentType === 'codex' || parsed.agentType === 'gemini' || parsed.agentType === 'opencode' || parsed.agentType === 'openclaw'
            ? parsed.agentType
            : 'opencode';
        const permissionMode: PermissionModeKey = typeof parsed.permissionMode === 'string'
            ? parsed.permissionMode
            : 'default';
        const modelMode: string = typeof parsed.modelMode === 'string' ? parsed.modelMode : 'default';
        const effortLevel: string | null = typeof parsed.effortLevel === 'string' ? parsed.effortLevel : null;
        const sessionType: NewSessionSessionType = parsed.sessionType === 'worktree' ? 'worktree' : 'simple';
        const worktreeKey = typeof parsed.worktreeKey === 'string' ? parsed.worktreeKey : null;
        const updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now();

        return {
            input,
            selectedMachineId,
            selectedPath,
            agentType,
            permissionMode,
            modelMode,
            effortLevel,
            fastMode: parsed.fastMode === true,
            sessionType,
            worktreeKey,
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

function parseStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

export function loadSessionManagementPreferences(): SessionManagementPreferences {
    const raw = mmkv.getString(SESSION_MANAGEMENT_KEY);
    if (!raw) {
        return { pinnedOrder: [], focusOrder: [] };
    }
    try {
        const parsed = JSON.parse(raw);
        return {
            pinnedOrder: parseStringArray(parsed?.pinnedOrder),
            focusOrder: parseStringArray(parsed?.focusOrder),
        };
    } catch (e) {
        console.error('Failed to parse session management preferences', e);
        return { pinnedOrder: [], focusOrder: [] };
    }
}

export function saveSessionManagementPreferences(preferences: SessionManagementPreferences) {
    mmkv.set(SESSION_MANAGEMENT_KEY, JSON.stringify(preferences));
}

export function loadLegacySessionPinnedOrder(): string[] {
    return loadSessionManagementPreferences().pinnedOrder;
}

export function clearLegacySessionPinnedOrder(): void {
    const preferences = loadSessionManagementPreferences();
    if (preferences.pinnedOrder.length === 0) return;
    saveSessionManagementPreferences({ ...preferences, pinnedOrder: [] });
}

export function loadSessionManagementFocusOrder(): string[] {
    return loadSessionManagementPreferences().focusOrder;
}

export function saveSessionManagementFocusOrder(focusOrder: string[]): void {
    const preferences = loadSessionManagementPreferences();
    saveSessionManagementPreferences({ ...preferences, focusOrder });
}

export function loadRegisteredPushToken(): string | null {
    return mmkv.getString(REGISTERED_PUSH_TOKEN_KEY) ?? null;
}

export function saveRegisteredPushToken(token: string) {
    mmkv.set(REGISTERED_PUSH_TOKEN_KEY, token);
}

export function clearRegisteredPushToken() {
    mmkv.delete(REGISTERED_PUSH_TOKEN_KEY);
}

export function loadSessionPermissionModes(): Record<string, string> {
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

export function saveSessionPermissionModes(modes: Record<string, string>) {
    mmkv.set('session-permission-modes', JSON.stringify(modes));
}

export function loadSessionModelModes(): Record<string, string> {
    const modes = mmkv.getString('session-model-modes');
    if (modes) {
        try {
            return JSON.parse(modes);
        } catch (e) {
            console.error('Failed to parse session model modes', e);
            return {};
        }
    }
    return {};
}

export function saveSessionModelModes(modes: Record<string, string>) {
    mmkv.set('session-model-modes', JSON.stringify(modes));
}

export function loadSessionEffortLevels(): Record<string, string> {
    const levels = mmkv.getString('session-effort-levels');
    if (levels) {
        try {
            return JSON.parse(levels);
        } catch (e) {
            console.error('Failed to parse session effort levels', e);
            return {};
        }
    }
    return {};
}

export function saveSessionEffortLevels(levels: Record<string, string>) {
    mmkv.set('session-effort-levels', JSON.stringify(levels));
}

export function loadSessionFastModes(): Record<string, boolean> {
    const modes = mmkv.getString('session-fast-modes');
    if (!modes) return {};
    try {
        return Object.fromEntries(Object.entries(JSON.parse(modes)).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'));
    } catch {
        return {};
    }
}

export function saveSessionFastModes(modes: Record<string, boolean>) {
    mmkv.set('session-fast-modes', JSON.stringify(modes));
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

export function getVoiceSoftPaywallShownCount(): number {
    return mmkv.getNumber(VOICE_SOFT_PAYWALL_SHOWN_KEY) ?? 0;
}

export function incrementVoiceSoftPaywallShown() {
    mmkv.set(VOICE_SOFT_PAYWALL_SHOWN_KEY, getVoiceSoftPaywallShownCount() + 1);
}

export function getVoiceOnboardingPromptLoadCount(): number {
    return mmkv.getNumber(VOICE_ONBOARDING_PROMPT_LOAD_COUNT_KEY) ?? 0;
}

export function incrementVoiceOnboardingPromptLoadCount() {
    mmkv.set(VOICE_ONBOARDING_PROMPT_LOAD_COUNT_KEY, getVoiceOnboardingPromptLoadCount() + 1);
}

export function getVoiceMessageCount(): number {
    return mmkv.getNumber(VOICE_MESSAGE_COUNT_KEY) ?? 0;
}

export function incrementVoiceMessageCount() {
    mmkv.set(VOICE_MESSAGE_COUNT_KEY, getVoiceMessageCount() + 1);
}

export function getVoiceLocalCounters() {
    return {
        softPaywallShownCount: getVoiceSoftPaywallShownCount(),
        onboardingPromptLoadCount: getVoiceOnboardingPromptLoadCount(),
        voiceMessageCount: getVoiceMessageCount(),
    };
}

export function resetVoiceLocalCounters() {
    mmkv.delete(VOICE_SOFT_PAYWALL_SHOWN_KEY);
    mmkv.delete(VOICE_ONBOARDING_PROMPT_LOAD_COUNT_KEY);
    mmkv.delete(VOICE_MESSAGE_COUNT_KEY);
}

export function clearPersistence() {
    cleanupRemovedAdvisorImages(loadLocalSettings().relationshipAdvisorConversations, []);
    clearComposeDraft();
    mmkv.clearAll();
    clearPublicSessionShareQueueStorage();
}

export type FileWorkspaceUI = { tabs: string[]; active: string | null; open: boolean; width: number; widthCustomized?: boolean };
export function loadFileWorkspaceUI(scope: string): FileWorkspaceUI {
    try {
        const raw = JSON.parse(mmkv.getString(`file-workspace-v1:${scope}`) ?? '{}');
        const tabs = Array.isArray(raw.tabs) ? raw.tabs.filter((path: unknown): path is string => typeof path === 'string' && path.length < 8192).slice(0, 20) : [];
        const validWidth = typeof raw.width === 'number' && Number.isFinite(raw.width);
        return { tabs, active: typeof raw.active === 'string' && tabs.includes(raw.active) ? raw.active : tabs[0] ?? null, open: raw.open === true,
            width: validWidth ? Math.max(310, raw.width) : 430,
            // Older snapshots stored 430 even when the user never touched the divider.
            widthCustomized: raw.widthCustomized === true || (raw.widthCustomized === undefined && validWidth && raw.width !== 430) };
    } catch { return { tabs: [], active: null, open: false, width: 430, widthCustomized: false }; }
}
export function saveFileWorkspaceUI(scope: string, ui: FileWorkspaceUI) {
    // Persist navigation only; file contents remain on the session machine.
    mmkv.set(`file-workspace-v1:${scope}`, JSON.stringify(ui));
}


export type WorkspaceDrafts = Record<string, { draft: string; hash: string }>;
export function loadFileWorkspaceDrafts(scope: string): WorkspaceDrafts {
    try {
        const value = JSON.parse(mmkv.getString('file-workspace-drafts:' + scope) ?? '{}');
        if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
        const entries = Object.entries(value).slice(0, 20).filter(([path, entry]: [string, any]) => path.length <= 4096 && entry && typeof entry.draft === 'string' && typeof entry.hash === 'string');
        return JSON.stringify(entries).length <= 4 * 1024 * 1024 ? Object.fromEntries(entries) as WorkspaceDrafts : {};
    } catch { return {}; }
}
export function saveFileWorkspaceDrafts(scope: string, drafts: WorkspaceDrafts) {
    const encoded = JSON.stringify(drafts);
    if (encoded.length > 4 * 1024 * 1024) return false;
    mmkv.set('file-workspace-drafts:' + scope, encoded);
    return true;
}


/** Pending composer context belongs to the same private scope as workspace drafts. */
export function loadFileWorkspaceReference(scope: string): import('@/components/fileWorkspace/context').FileReference | null {
    try {
        const value = JSON.parse(mmkv.getString('file-workspace-reference:' + scope) ?? 'null');
        if (!value || typeof value.path !== 'string' || value.path.length > 8192 || !value.path
            || typeof value.hash !== 'string' || !/^[a-f0-9]{64}$/i.test(value.hash)
            || (value.quote !== undefined && (typeof value.quote !== 'string' || value.quote.length > 4000))) return null;
        const a = value.artifact;
        const artifact = a && /^[a-zA-Z0-9_-]{1,128}$/.test(a.workspaceId) && /^[a-zA-Z0-9_-]{1,128}$/.test(a.artifactId) && /^[a-f0-9]{64}$/.test(a.expectedRevision) ? {workspaceId:a.workspaceId,artifactId:a.artifactId,expectedRevision:a.expectedRevision,...(typeof a.versionId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(a.versionId) ? {versionId:a.versionId} : {})} : undefined;
        return { path: value.path, hash: value.hash, ...(value.quote === undefined ? {} : { quote: value.quote }), ...(artifact ? {artifact} : {}) };
    } catch { return null; }
}
export function saveFileWorkspaceReference(scope: string, reference: import('@/components/fileWorkspace/context').FileReference | null) {
    const key = 'file-workspace-reference:' + scope;
    if (reference) mmkv.set(key, JSON.stringify(reference)); else mmkv.delete(key);
}

/** Uncertain operations survive refresh in the same private account/session scope. */
export function loadWorkspaceVersionOperations(scope: string): Record<string, import('@/components/fileWorkspace/versionController').PendingVersionOperation> {
    try {
        const value = JSON.parse(mmkv.getString('file-workspace-operations:' + scope) ?? '{}');
        if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
        return Object.fromEntries(Object.entries(value).slice(0,20).filter(([path, v]: [string, any]) => {
            if (path.length > 8192 || !v || typeof v.operationId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(v.operationId) || typeof v.workspaceId !== 'string' || !['restore','save','register'].includes(v.kind)) return false;
            if (v.managedPaths !== undefined && (!Array.isArray(v.managedPaths) || v.managedPaths.length > 128 || !v.managedPaths.every((p: unknown) => typeof p === 'string' && p.length > 0 && p.length <= 8192))) return false;
            if (v.resolution !== undefined && (!v.resolution || typeof v.resolution.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(v.resolution.id) || !['resume','rollback'].includes(v.resolution.action))) return false;
            if (v.request !== undefined) {
                const method: unknown = v.request?.method;
                if (method !== 'artifactSave' && method !== 'artifactRestore') return false;
                const request = ArtifactRequests[method].safeParse(v.request.input);
                if (!request.success || request.data.operationId !== v.operationId || request.data.workspaceId !== v.workspaceId) return false;
                v.request = { method, input: request.data };
            }
            return true;
        })) as any;
    } catch { return {}; }
}
export function saveWorkspaceVersionOperations(scope: string, value: Record<string, import('@/components/fileWorkspace/versionController').PendingVersionOperation>) {
    mmkv.set('file-workspace-operations:' + scope, JSON.stringify(value));
}
