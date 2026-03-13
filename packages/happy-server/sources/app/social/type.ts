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
    publicKey: string;
    contentPublicKey: string | null;
    contentPublicKeySig: string | null;
}

export function buildUserProfile(
    account: {
        id: string;
        firstName: string | null;
        lastName: string | null;
        username: string | null;
        avatar: unknown;
        githubUser: { profile: unknown } | null;
        publicKey: string;
        contentPublicKey: Uint8Array | null;
        contentPublicKeySig: Uint8Array | null;
    },
    status: RelationshipStatus
): UserProfile {
    const githubProfile = (account.githubUser?.profile ?? null) as GitHubProfile | null;
    const avatarJson = account.avatar as ImageRef | null;

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
        status,
        publicKey: account.publicKey,
        contentPublicKey: account.contentPublicKey ? Buffer.from(account.contentPublicKey).toString('base64') : null,
        contentPublicKeySig: account.contentPublicKeySig ? Buffer.from(account.contentPublicKeySig).toString('base64') : null,
    };
}
