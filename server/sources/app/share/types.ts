import { getPublicUrl } from "@/storage/files";

/**
 * Common select for user profile information
 */
export const PROFILE_SELECT = {
    id: true,
    firstName: true,
    lastName: true,
    username: true,
    avatar: true
} as const;

/**
 * User profile type (inferred from PROFILE_SELECT)
 */
export type UserProfile = {
    id: string;
    firstName: string | null;
    lastName: string | null;
    username: string | null;
    avatar: string | null;
};

export function toShareUserProfile(profile: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    username: string | null;
    avatar: any | null;
}): UserProfile {
    const avatarJson = profile.avatar as any | null;
    const avatarPath = avatarJson && typeof avatarJson === 'object' ? avatarJson.path : null;
    const avatarUrl = typeof avatarPath === 'string' ? getPublicUrl(avatarPath) : null;
    return {
        id: profile.id,
        firstName: profile.firstName,
        lastName: profile.lastName,
        username: profile.username,
        avatar: avatarUrl
    };
}
