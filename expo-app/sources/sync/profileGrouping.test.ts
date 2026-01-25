import { describe, expect, it } from 'vitest';
import { buildProfileGroups, toggleFavoriteProfileId } from './profileGrouping';

describe('toggleFavoriteProfileId', () => {
    it('adds the profile id to the front when missing', () => {
        expect(toggleFavoriteProfileId([], 'anthropic')).toEqual(['anthropic']);
    });

    it('removes the profile id when already present', () => {
        expect(toggleFavoriteProfileId(['anthropic', 'openai'], 'anthropic')).toEqual(['openai']);
    });

    it('supports favoriting the default environment (empty profile id)', () => {
        expect(toggleFavoriteProfileId(['anthropic'], '')).toEqual(['', 'anthropic']);
        expect(toggleFavoriteProfileId(['', 'anthropic'], '')).toEqual(['anthropic']);
    });
});

describe('buildProfileGroups', () => {
    it('filters favoriteIds to resolvable profiles (preserves default environment favorite)', () => {
        const customProfiles = [
            {
                id: 'custom-profile',
                name: 'Custom Profile',
                environmentVariables: [],
                defaultPermissionModeByAgent: {},
                compatibility: { claude: true, codex: true, gemini: true },
                envVarRequirements: [],
                isBuiltIn: false,
                createdAt: 0,
                updatedAt: 0,
                version: '1.0.0',
            },
        ];

        const groups = buildProfileGroups({
            customProfiles,
            favoriteProfileIds: ['', 'anthropic', 'missing-profile', 'custom-profile'],
        });

        expect(groups.favoriteIds.has('')).toBe(true);
        expect(groups.favoriteIds.has('anthropic')).toBe(true);
        expect(groups.favoriteIds.has('custom-profile')).toBe(true);
        expect(groups.favoriteIds.has('missing-profile')).toBe(false);
    });

    it('hides profiles that are incompatible with all enabled agents', () => {
        const customProfiles = [
            {
                id: 'custom-gemini-only',
                name: 'Gemini Only',
                environmentVariables: [],
                defaultPermissionModeByAgent: {},
                compatibility: { claude: false, codex: false, gemini: true },
                envVarRequirements: [],
                isBuiltIn: false,
                createdAt: 0,
                updatedAt: 0,
                version: '1.0.0',
            },
        ];

        const groups = buildProfileGroups({
            customProfiles,
            favoriteProfileIds: ['gemini', 'custom-gemini-only'],
            enabledAgentIds: ['claude', 'codex'],
        });

        expect(groups.builtInProfiles.some((p) => p.id === 'gemini')).toBe(false);
        expect(groups.builtInProfiles.some((p) => p.id === 'gemini-api-key')).toBe(false);
        expect(groups.builtInProfiles.some((p) => p.id === 'gemini-vertex')).toBe(false);
        expect(groups.favoriteProfiles.some((p) => p.id === 'custom-gemini-only')).toBe(false);
        expect(groups.customProfiles.some((p) => p.id === 'custom-gemini-only')).toBe(false);
    });
});
