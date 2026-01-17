import { describe, expect, it } from 'vitest';
import { getBuiltInProfileNameKey, getProfilePrimaryCli } from './profileUtils';

describe('getProfilePrimaryCli', () => {
    it('ignores unknown compatibility keys', () => {
        const profile = {
            compatibility: { unknownCli: true },
        } as any;

        expect(getProfilePrimaryCli(profile)).toBe('none');
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
