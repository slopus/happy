import { describe, expect, it, vi } from 'vitest';
import type { AIBackendProfile } from '@/sync/settings';
import { getProfileBackendSubtitle, getProfileSubtitle } from '@/components/profiles/profileListModel';

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('profileListModel', () => {
    const strings = {
        builtInLabel: 'Built-in',
        customLabel: 'Custom',
        agentLabelById: {
            claude: 'Claude',
            codex: 'Codex',
            opencode: 'OpenCode',
            gemini: 'Gemini',
            auggie: 'Auggie',
        },
    };

    it('builds backend subtitle for enabled compatible agents', () => {
        const profile = { isBuiltIn: false, compatibility: { claude: true, codex: true, opencode: true, gemini: true, auggie: true } } as Pick<AIBackendProfile, 'compatibility' | 'isBuiltIn'>;
        expect(getProfileBackendSubtitle({ profile, enabledAgentIds: ['claude', 'codex'], strings })).toBe('Claude • Codex');
    });

    it('skips disabled agents even if compatible', () => {
        const profile = { isBuiltIn: false, compatibility: { claude: true, codex: true, opencode: true, gemini: true, auggie: true } } as Pick<AIBackendProfile, 'compatibility' | 'isBuiltIn'>;
        expect(getProfileBackendSubtitle({ profile, enabledAgentIds: ['claude', 'gemini'], strings })).toBe('Claude • Gemini');
    });

    it('builds built-in subtitle with backend', () => {
        const profile = { isBuiltIn: true, compatibility: { claude: true, codex: false, opencode: false, gemini: false, auggie: false } } as Pick<AIBackendProfile, 'compatibility' | 'isBuiltIn'>;
        expect(getProfileSubtitle({ profile, enabledAgentIds: ['claude', 'codex'], strings })).toBe('Built-in · Claude');
    });

    it('builds custom subtitle without backend', () => {
        const profile = { isBuiltIn: false, compatibility: { claude: false, codex: false, opencode: false, gemini: false, auggie: false } } as Pick<AIBackendProfile, 'compatibility' | 'isBuiltIn'>;
        expect(getProfileSubtitle({ profile, enabledAgentIds: ['claude', 'codex', 'gemini'], strings })).toBe('Custom');
    });
});
