import { getPublicUrl, ImageRef } from "@/storage/files";
import { RelationshipStatus } from "@prisma/client";
import { GitHubProfile } from "../api/types";

export type UserProfile = {
    id: string;
    firstName: string;
    lastName: string | null;
    avatar: {
        path: string;
        url: string;
        width?: number;
        height?: number;
        thumbhash?: string;
    } | null;
    username: string;
    bio: string | null;
    status: RelationshipStatus;
}

export function buildUserProfile(
    account: {
        id: string;
        firstName: string | null;
        lastName: string | null;
        username: string | null;
        avatar: ImageRef | null;
        githubUser: { profile: GitHubProfile } | null;
    },
    status: RelationshipStatus
): UserProfile {
    const githubProfile = account.githubUser?.profile;
    const avatarJson = account.avatar;

    let avatar: UserProfile['avatar'] = null;
    if (avatarJson) {
        const avatarData = avatarJson;
        avatar = {
            path: avatarData.path,
            url: getPublicUrl(avatarData.path),
            width: avatarData.width,
            height: avatarData.height,
            thumbhash: avatarData.thumbhash
        };
    }

    return {
        id: account.id,
        firstName: account.firstName || '',
        lastName: account.lastName,
        avatar,
        username: account.username || githubProfile?.login || '',
        bio: githubProfile?.bio || null,
        status
    };
}