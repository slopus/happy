import { db } from "@/prisma";
import { ShareAccessLevel } from "@prisma/client";

/**
 * Access level for session sharing (including owner)
 */
export type AccessLevel = ShareAccessLevel | 'owner';

/**
 * Session access information for a user
 */
export interface SessionAccess {
    /** User ID requesting access */
    userId: string;
    /** Session ID being accessed */
    sessionId: string;
    /** Access level granted to user */
    level: AccessLevel;
    /** Whether user is session owner */
    isOwner: boolean;
}

/**
 * Check user's access level for a session
 *
 * @param userId - User ID requesting access
 * @param sessionId - Session ID to check
 * @returns Session access info, or null if no access
 */
export async function checkSessionAccess(
    userId: string,
    sessionId: string
): Promise<SessionAccess | null> {
    // First check if user owns the session
    const session = await db.session.findUnique({
        where: { id: sessionId },
        select: { accountId: true }
    });

    if (!session) {
        return null;
    }

    if (session.accountId === userId) {
        return {
            userId,
            sessionId,
            level: 'owner',
            isOwner: true
        };
    }

    // Check if session is shared with user
    const share = await db.sessionShare.findUnique({
        where: {
            sessionId_sharedWithUserId: {
                sessionId,
                sharedWithUserId: userId
            }
        },
        select: { accessLevel: true }
    });

    if (share) {
        return {
            userId,
            sessionId,
            level: share.accessLevel,
            isOwner: false
        };
    }

    return null;
}

/**
 * Check if user has required access level
 *
 * @param access - User's session access
 * @param required - Required access level
 * @returns True if user has sufficient access
 */
export function requireAccessLevel(
    access: SessionAccess,
    required: AccessLevel
): boolean {
    const levels: AccessLevel[] = ['view', 'edit', 'admin', 'owner'];
    const userLevel = levels.indexOf(access.level);
    const requiredLevel = levels.indexOf(required);
    return userLevel >= requiredLevel;
}

/**
 * Check if user can view session
 *
 * @param userId - User ID requesting access
 * @param sessionId - Session ID to check
 * @returns True if user can view session
 */
export async function canViewSession(
    userId: string,
    sessionId: string
): Promise<boolean> {
    const access = await checkSessionAccess(userId, sessionId);
    return access !== null;
}

/**
 * Check if user can send messages to session
 *
 * @param userId - User ID requesting access
 * @param sessionId - Session ID to check
 * @returns True if user can send messages
 */
export async function canSendMessages(
    userId: string,
    sessionId: string
): Promise<boolean> {
    const access = await checkSessionAccess(userId, sessionId);
    if (!access) return false;
    return requireAccessLevel(access, 'edit');
}

/**
 * Check if user can manage sharing settings
 *
 * @param userId - User ID requesting access
 * @param sessionId - Session ID to check
 * @returns True if user can manage sharing
 */
export async function canManageSharing(
    userId: string,
    sessionId: string
): Promise<boolean> {
    const access = await checkSessionAccess(userId, sessionId);
    if (!access) return false;
    return requireAccessLevel(access, 'admin');
}

/**
 * Check if user owns the session
 *
 * @param userId - User ID requesting access
 * @param sessionId - Session ID to check
 * @returns True if user owns the session
 */
export async function isSessionOwner(
    userId: string,
    sessionId: string
): Promise<boolean> {
    const access = await checkSessionAccess(userId, sessionId);
    return access?.isOwner ?? false;
}

/**
 * Check public share access with blocking and limits
 *
 * Public shares are always view-only for security
 *
 * @param token - Public share token
 * @param userId - User ID accessing (null for anonymous)
 * @returns Public share info if valid, null otherwise
 */
export async function checkPublicShareAccess(
    token: string,
    userId: string | null
): Promise<{
    sessionId: string;
    publicShareId: string;
} | null> {
    const publicShare = await db.publicSessionShare.findUnique({
        where: { token },
        select: {
            id: true,
            sessionId: true,
            expiresAt: true,
            maxUses: true,
            useCount: true,
            blockedUsers: userId ? {
                where: { userId },
                select: { id: true }
            } : undefined
        }
    });

    if (!publicShare) {
        return null;
    }

    // Check if expired
    if (publicShare.expiresAt && publicShare.expiresAt < new Date()) {
        return null;
    }

    // Check if max uses exceeded
    if (publicShare.maxUses && publicShare.useCount >= publicShare.maxUses) {
        return null;
    }

    // Check if user is blocked
    if (userId && publicShare.blockedUsers && publicShare.blockedUsers.length > 0) {
        return null;
    }

    return {
        sessionId: publicShare.sessionId,
        publicShareId: publicShare.id
    };
}
