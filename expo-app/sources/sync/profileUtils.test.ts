import { describe, expect, it } from 'vitest';
import { getBuiltInProfileNameKey, getProfilePrimaryCli, getProfileSupportedAgentIds, isProfileCompatibleWithAnyAgent } from './profileUtils';

describe('getProfilePrimaryCli', () => {
    it('ignores unknown compatibility keys', () => {
        const profile = {
            compatibility: { unknownCli: true },
        } as any;

        expect(getProfilePrimaryCli(profile)).toBe('none');
    });
});

describe('getProfileSupportedAgentIds', () => {
    it('returns supported agent ids and ignores unknown keys', () => {
        const profile = {
            compatibility: { claude: true, codex: false, gemini: true, unknownCli: true },
        } as any;

        expect(getProfileSupportedAgentIds(profile)).toEqual(['claude', 'gemini']);
    });
});

describe('getBuiltInProfileNameKey', () => {
    it('returns the translation key for known built-in profile ids', () => {
        expect(getBuiltInProfileNameKey('anthropic')).toBe('profiles.builtInNames.anthropic');
        expect(getBuiltInProfileNameKey('deepseek')).toBe('profiles.builtInNames.deepseek');
        expect(getBuiltInProfileNameKey('zai')).toBe('profiles.builtInNames.zai');
        expect(getBuiltInProfileNameKey('openai')).toBe('profiles.builtInNames.openai');
        expect(getBuiltInProfileNameKey('azure-openai')).toBe('profiles.builtInNames.azureOpenai');
    });

    it('returns null for unknown ids', () => {
        expect(getBuiltInProfileNameKey('unknown')).toBeNull();
    });
});

describe('isProfileCompatibleWithAnyAgent', () => {
    it('returns false when no enabled agents are compatible', () => {
        const profile = {
            isBuiltIn: true,
            compatibility: { gemini: true, codex: false, claude: false },
        } as any;

        expect(isProfileCompatibleWithAnyAgent(profile, ['claude', 'codex'])).toBe(false);
    });

    it('returns true when at least one enabled agent is compatible', () => {
        const profile = {
            isBuiltIn: true,
            compatibility: { gemini: true, codex: false, claude: false },
        } as any;

        expect(isProfileCompatibleWithAnyAgent(profile, ['claude', 'gemini'])).toBe(true);
    });

    it('treats custom profiles with no compatibility map as compatible', () => {
        const profile = {
            isBuiltIn: false,
            compatibility: undefined,
        } as any;

        expect(isProfileCompatibleWithAnyAgent(profile, ['claude'])).toBe(true);
    });
});
