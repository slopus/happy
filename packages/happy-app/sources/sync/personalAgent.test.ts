import { describe, expect, it } from 'vitest';
import { isPersonalAgentConversation, personalAgentDisplayName, selectPersonalAgentConversation } from './personalAgent';
import { applyLocalSettings, localSettingsDefaults } from './localSettings';
import { settingsParse, settingsToSyncPayload } from './settings';
import type { Session } from './storageTypes';

const session = (id: string, createdAt: number, flavor: string, updatedAt = createdAt) => ({
    id, createdAt, updatedAt, metadata: { flavor },
} as Session);

describe('Personal conversation identity', () => {
    it('keeps the saved conversation when history is paginated and never replaces it with an ordinary session', () => {
        expect(selectPersonalAgentConversation([session('ordinary', 20, 'codex')], 'unloaded-personal')).toBe('unloaded-personal');
        expect(selectPersonalAgentConversation([session('ordinary', 20, 'codex')], null)).toBeNull();
    });
    it('adopts existing Personal history once and does not pick by heartbeat time', () => {
        const sessions = [session('old', 1, 'personal', 100), session('latest', 5, 'personal'), session('codex', 10, 'codex')];
        expect(selectPersonalAgentConversation(sessions, null)).toBe('latest');
        const archived = { ...session('archived', 50, 'personal'), metadata: { flavor: 'personal', path: '/personal', host: 'test', lifecycleState: 'archived' } };
        expect(selectPersonalAgentConversation([...sessions, archived], null)).toBe('latest');
        expect(selectPersonalAgentConversation(sessions, 'old')).toBe('old');
        expect(isPersonalAgentConversation(session('codex', 10, 'codex'))).toBe(false);
    });
});

describe('Personal account profile', () => {
    it('migrates old settings and round-trips identity and avatar through the encrypted settings payload', () => {
        expect(settingsParse({}).personalAgentName).toBe('Paws');
        const original = settingsParse({ personalAgentName: '小爪', personalAgentAvatar: 'data:image/jpeg;base64,YXZhdGFy' });
        const restored = settingsParse(settingsToSyncPayload(original));
        expect(restored.personalAgentName).toBe('小爪');
        expect(restored.personalAgentAvatar).toBe('data:image/jpeg;base64,YXZhdGFy');
        const local = applyLocalSettings(localSettingsDefaults, { personalAgentConversationId: 'my-thread' });
        expect(applyLocalSettings(local, { themePreference: 'dark' }).personalAgentConversationId).toBe('my-thread');
        expect(settingsToSyncPayload(original)).not.toHaveProperty('personalAgentConversationId');
    });
    it('rejects remote, script and oversized avatar payloads without resetting unrelated settings', () => {
        for (const avatar of ['https://example.com/tracker.png', 'data:image/svg+xml;base64,PHN2Zz4=', `data:image/jpeg;base64,${'A'.repeat(180_000)}`]) {
            const settings = settingsParse({ personalAgentAvatar: avatar, personalAgentName: '小爪', customInstructions: 'keep this' });
            expect(settings.personalAgentAvatar).toBeNull();
            expect(settings.personalAgentName).toBe('小爪');
            expect(settings.customInstructions).toBe('keep this');
        }
        expect(personalAgentDisplayName('   ')).toBe('Paws');
    });
});
