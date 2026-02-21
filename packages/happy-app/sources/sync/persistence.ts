import { MMKV } from 'react-native-mmkv';
import { Settings, settingsDefaults, settingsParse, SettingsSchema } from './settings';
import { LocalSettings, localSettingsDefaults, localSettingsParse } from './localSettings';
import { Profile, profileDefaults, profileParse } from './profile';
import type { PermissionMode } from '@/components/PermissionModeSelector';
import { DooTaskProfile, DooTaskProfileSchema } from './dootask/types';

const mmkv = new MMKV();
const NEW_SESSION_DRAFT_KEY = 'new-session-draft-v1';

export type NewSessionAgentType = 'claude' | 'codex' | 'gemini';
export type NewSessionSessionType = 'simple' | 'worktree';

export interface NewSessionDraft {
    input: string;
    selectedMachineId: string | null;
    selectedPath: string | null;
    agentType: NewSessionAgentType;
    permissionMode: PermissionMode;
    sessionType: NewSessionSessionType;
    updatedAt: number;
}

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
    mmkv.set('settings', JSON.stringify({ settings, version }));
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
        const agentType: NewSessionAgentType = parsed.agentType === 'codex' || parsed.agentType === 'gemini'
            ? parsed.agentType
            : 'claude';
        const permissionMode: PermissionMode = typeof parsed.permissionMode === 'string'
            ? (parsed.permissionMode as PermissionMode)
            : 'default';
        const sessionType: NewSessionSessionType = parsed.sessionType === 'worktree' ? 'worktree' : 'simple';
        const updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now();

        return {
            input,
            selectedMachineId,
            selectedPath,
            agentType,
            permissionMode,
            sessionType,
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

const SESSION_LAST_VIEWED_KEY = 'session-last-viewed-at';

export function loadSessionLastViewedAt(): Map<string, number> {
    const raw = mmkv.getString(SESSION_LAST_VIEWED_KEY);
    if (raw) {
        try {
            const obj = JSON.parse(raw);
            return new Map(Object.entries(obj));
        } catch (e) {
            return new Map();
        }
    }
    return new Map();
}

export function saveSessionLastViewedAt(map: Map<string, number>) {
    mmkv.set(SESSION_LAST_VIEWED_KEY, JSON.stringify(Object.fromEntries(map)));
}

export function loadDooTaskProfile(): DooTaskProfile | null {
    const raw = mmkv.getString('dootask-profile');
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        return DooTaskProfileSchema.parse(parsed);
    } catch {
        return null;
    }
}

export function saveDooTaskProfile(profile: DooTaskProfile | null): void {
    if (profile) {
        mmkv.set('dootask-profile', JSON.stringify(profile));
    } else {
        mmkv.delete('dootask-profile');
    }
}

export function loadDooTaskUserCache(): { cache: Record<number, string>; fetchedAt: number | null } {
    const raw = mmkv.getString('dootask-user-cache');
    if (!raw) return { cache: {}, fetchedAt: null };
    try {
        const parsed = JSON.parse(raw);
        return { cache: parsed.cache || {}, fetchedAt: parsed.fetchedAt ?? null };
    } catch {
        return { cache: {}, fetchedAt: null };
    }
}

export function saveDooTaskUserCache(cache: Record<number, string>, fetchedAt: number | null): void {
    mmkv.set('dootask-user-cache', JSON.stringify({ cache, fetchedAt }));
}

export function clearDooTaskUserCache(): void {
    mmkv.delete('dootask-user-cache');
}

export function loadDooTaskProjects(): { projects: Array<{ id: number; name: string }>; fetchedAt: number | null } {
    const raw = mmkv.getString('dootask-projects');
    if (!raw) return { projects: [], fetchedAt: null };
    try {
        const parsed = JSON.parse(raw);
        return { projects: parsed.projects || [], fetchedAt: parsed.fetchedAt ?? null };
    } catch {
        return { projects: [], fetchedAt: null };
    }
}

export function saveDooTaskProjects(projects: Array<{ id: number; name: string }>, fetchedAt: number | null): void {
    mmkv.set('dootask-projects', JSON.stringify({ projects, fetchedAt }));
}

export function clearDooTaskProjects(): void {
    mmkv.delete('dootask-projects');
}

export function clearPersistence() {
    mmkv.clearAll();
}
