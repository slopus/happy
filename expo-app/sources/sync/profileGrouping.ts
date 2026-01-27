import { AIBackendProfile } from '@/sync/settings';
import { DEFAULT_PROFILES, getBuiltInProfile } from '@/sync/profileUtils';
import type { AgentId } from '@/agents/catalog';
import { getProfileCompatibleAgentIds } from '@/sync/profileUtils';

export interface ProfileGroups {
    favoriteProfiles: AIBackendProfile[];
    customProfiles: AIBackendProfile[];
    builtInProfiles: AIBackendProfile[];
    favoriteIds: Set<string>;
    builtInIds: Set<string>;
}

function isProfile(profile: AIBackendProfile | null | undefined): profile is AIBackendProfile {
    return Boolean(profile);
}

export function toggleFavoriteProfileId(favoriteProfileIds: string[], profileId: string): string[] {
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const id of favoriteProfileIds) {
        if (seen.has(id)) continue;
        seen.add(id);
        normalized.push(id);
    }

    if (seen.has(profileId)) {
        return normalized.filter((id) => id !== profileId);
    }

    return [profileId, ...normalized];
}

export function buildProfileGroups({
    customProfiles,
    favoriteProfileIds,
    enabledAgentIds,
}: {
    customProfiles: AIBackendProfile[];
    favoriteProfileIds: string[];
    enabledAgentIds?: readonly AgentId[];
}): ProfileGroups {
    const builtInIds = new Set(DEFAULT_PROFILES.map((profile) => profile.id));

    const customById = new Map(customProfiles.map((profile) => [profile.id, profile] as const));

    const isVisible = (profile: AIBackendProfile): boolean => {
        if (!enabledAgentIds) return true;
        return getProfileCompatibleAgentIds(profile, enabledAgentIds).length > 0;
    };

    const favoriteProfiles = favoriteProfileIds
        .map((id) => customById.get(id) ?? getBuiltInProfile(id))
        .filter(isProfile);
    const visibleFavoriteProfiles = favoriteProfiles.filter(isVisible);

    const favoriteIds = new Set<string>(visibleFavoriteProfiles.map((profile) => profile.id));
    // Preserve "default environment" favorite marker (not a real profile object).
    if (favoriteProfileIds.includes('')) {
        favoriteIds.add('');
    }

    const nonFavoriteCustomProfiles = customProfiles
        .filter(isVisible)
        .filter((profile) => !favoriteIds.has(profile.id));

    const nonFavoriteBuiltInProfiles = DEFAULT_PROFILES
        .map((profile) => getBuiltInProfile(profile.id))
        .filter(isProfile)
        .filter(isVisible)
        .filter((profile) => !favoriteIds.has(profile.id));

    return {
        favoriteProfiles: visibleFavoriteProfiles,
        customProfiles: nonFavoriteCustomProfiles,
        builtInProfiles: nonFavoriteBuiltInProfiles,
        favoriteIds,
        builtInIds,
    };
}
