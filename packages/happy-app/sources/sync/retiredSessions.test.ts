import { describe, expect, it } from 'vitest';
import { agentKeys, getCodeAgentDefaults, normalizeAgentKey, resolveAgentDefaultConfig } from './agentDefaults';
import { settingsDefaults, settingsParse, settingsToSyncPayload } from './settings';
import { applyLocalSettings, localSettingsDefaults, localSettingsParse } from './localSettings';
import { isRetiredSession } from './retiredSessions';
import { getAvailableModels, getAvailablePermissionModes } from '@/components/modelModeOptions';
import { getAgentPermissionModeForTaskLevel } from '@/utils/taskPermissionModes';
import { resolveWorkingDirectoryAgent, resolveWorkingDirectorySwitchStrategy } from '@/utils/sessionWorkingDirectory';
import { canRegenerateSessionTitle } from '@/utils/sessionTitleRegeneration';

describe('retired Personal compatibility boundary', () => {
    it('does not map a retired flavor or its saved overrides to another engine', () => {
        expect(agentKeys).not.toContain('personal');
        expect(() => normalizeAgentKey('personal')).toThrow('personal-agent-retired');
        expect(() => getCodeAgentDefaults('personal')).toThrow('personal-agent-retired');
        expect(() => resolveAgentDefaultConfig({ personal: { modelMode: 'old/model' } }, 'personal'))
            .toThrow('personal-agent-retired');
        expect(getAgentPermissionModeForTaskLevel('personal', 'full-access')).toBeNull();
        expect(resolveWorkingDirectoryAgent('personal')).toBeNull();
        expect(resolveWorkingDirectorySwitchStrategy('personal', true)).toBe('unsupported');
        expect(canRegenerateSessionTitle({ presence: 'online', metadata: {
            flavor: 'personal', claudeSessionId: 'misleading-id', capabilities: { regenerateTitle: true },
        } } as any)).toBe(false);
    });

    it('offers no runnable models or modes even when legacy metadata reports them', () => {
        const metadata = { models: [{ code: 'model', value: 'Model' }], operatingModes: [{ code: 'yolo', value: 'YOLO' }] } as any;
        expect(getAvailableModels('personal', metadata, key => key)).toEqual([]);
        expect(getAvailablePermissionModes('personal', metadata, key => key)).toEqual([]);
        expect(isRetiredSession({ metadata: { flavor: 'personal' } })).toBe(true);
        expect(isRetiredSession({ metadata: { flavor: 'codex' } })).toBe(false);
        expect(isRetiredSession({})).toBe(false);
    });

    it('removes active profile defaults while retaining old account and device data as unknown fields', () => {
        expect(settingsDefaults).not.toHaveProperty('personalAgentName');
        expect(settingsDefaults).not.toHaveProperty('personalAgentAvatar');
        expect(localSettingsDefaults).not.toHaveProperty('personalAgentConversationId');
        const oldProfile = { personalAgentName: 'Saved name', personalAgentAvatar: 'saved-private-avatar', customInstructions: 'Keep this' };
        const account = settingsParse(oldProfile);
        expect(settingsToSyncPayload(account)).toMatchObject(oldProfile);
        const device = localSettingsParse({ personalAgentConversationId: 'saved-thread', themePreference: 'dark' });
        expect(applyLocalSettings(device, { debugMode: true })).toMatchObject({ personalAgentConversationId: 'saved-thread', themePreference: 'dark' });
    });

    it('retains legacy launch presets and sidebar organization without re-enabling the provider', () => {
        const launcher = { id: 'saved', name: 'Saved bot', glyph: 'P', color: 'blue', machineId: 'machine', path: '/saved', agentType: 'personal', presets: [] };
        expect(settingsParse({ agents: [launcher] }).agents[0]).toMatchObject(launcher);
        expect(localSettingsParse({ agents: [launcher] }).agents[0]).toMatchObject(launcher);
        const list = { id: 'saved-list', name: 'Saved', kind: 'workspace', color: 'blue', machineId: 'machine', path: '/saved', defaultAgent: 'personal', createdAt: 1 };
        expect(settingsParse({ sidebarOrganization: { lists: [list], tags: [], sessions: {} } }).sidebarOrganization.lists)
            .toEqual([list]);
    });
});
