import { AIBackendProfile } from '@/sync/settings';
import { DEFAULT_PROFILES, getBuiltInProfile } from '@/sync/profileUtils';

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
}: {
    customProfiles: AIBackendProfile[];
    favoriteProfileIds: string[];
}): ProfileGroups {
    const builtInIds = new Set(DEFAULT_PROFILES.map((profile) => profile.id));
    const favoriteIds = new Set(favoriteProfileIds);

    const customById = new Map(customProfiles.map((profile) => [profile.id, profile] as const));

    const favoriteProfiles = favoriteProfileIds
        .map((id) => customById.get(id) ?? getBuiltInProfile(id))
        .filter(isProfile);

    const nonFavoriteCustomProfiles = customProfiles.filter((profile) => !favoriteIds.has(profile.id));

    const nonFavoriteBuiltInProfiles = DEFAULT_PROFILES
        .map((profile) => getBuiltInProfile(profile.id))
        .filter(isProfile)
        .filter((profile) => !favoriteIds.has(profile.id));

    return {
        favoriteProfiles,
        customProfiles: nonFavoriteCustomProfiles,
        builtInProfiles: nonFavoriteBuiltInProfiles,
        favoriteIds,
        builtInIds,
    };
}
