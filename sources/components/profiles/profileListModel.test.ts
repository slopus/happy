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
        agentClaude: 'Claude',
        agentCodex: 'Codex',
        agentGemini: 'Gemini',
    };

    it('builds backend subtitle with experiments disabled', () => {
        const profile = { compatibility: { claude: true, codex: true, gemini: true } } as Pick<AIBackendProfile, 'compatibility'>;
        expect(getProfileBackendSubtitle({ profile, experimentsEnabled: false, strings })).toBe('Claude • Codex');
    });

    it('builds backend subtitle with experiments enabled', () => {
        const profile = { compatibility: { claude: true, codex: false, gemini: true } } as Pick<AIBackendProfile, 'compatibility'>;
        expect(getProfileBackendSubtitle({ profile, experimentsEnabled: true, strings })).toBe('Claude • Gemini');
    });

    it('builds built-in subtitle with backend', () => {
        const profile = { isBuiltIn: true, compatibility: { claude: true, codex: false, gemini: false } } as Pick<AIBackendProfile, 'compatibility' | 'isBuiltIn'>;
        expect(getProfileSubtitle({ profile, experimentsEnabled: false, strings })).toBe('Built-in · Claude');
    });

    it('builds custom subtitle without backend', () => {
        const profile = { isBuiltIn: false, compatibility: { claude: false, codex: false, gemini: false } } as Pick<AIBackendProfile, 'compatibility' | 'isBuiltIn'>;
        expect(getProfileSubtitle({ profile, experimentsEnabled: true, strings })).toBe('Custom');
    });
});
