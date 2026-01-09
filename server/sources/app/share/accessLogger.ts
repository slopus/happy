import { db } from "@/storage/db";

/**
 * Log access to a direct session share
 *
 * @param sessionShareId - Session share ID
 * @param userId - User ID who accessed
 * @param ipAddress - IP address (optional)
 * @param userAgent - User agent (optional)
 */
export async function logSessionShareAccess(
    sessionShareId: string,
    userId: string,
    ipAddress?: string,
    userAgent?: string
): Promise<void> {
    await db.sessionShareAccessLog.create({
        data: {
            sessionShareId,
            userId,
            ipAddress: ipAddress ?? null,
            userAgent: userAgent ?? null
        }
    });
}

/**
 * Log access to a public session share
 *
 * @param publicShareId - Public share ID
 * @param userId - User ID who accessed (null for anonymous)
 * @param ipAddress - IP address (optional)
 * @param userAgent - User agent (optional)
 */
export async function logPublicShareAccess(
    publicShareId: string,
    userId: string | null,
    ipAddress?: string,
    userAgent?: string
): Promise<void> {
    await db.publicShareAccessLog.create({
        data: {
            publicShareId,
            userId: userId ?? null,
            ipAddress: ipAddress ?? null,
            userAgent: userAgent ?? null
        }
    });
}

/**
 * Get IP address from request
 *
 * @param headers - Request headers
 * @returns IP address or undefined
 */
export function getIpAddress(headers: Record<string, string | string[] | undefined>): string | undefined {
    // Check common headers for IP address
    const forwardedFor = headers['x-forwarded-for'];
    if (forwardedFor) {
        const ip = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
        return ip.split(',')[0].trim();
    }

    const realIp = headers['x-real-ip'];
    if (realIp) {
        return Array.isArray(realIp) ? realIp[0] : realIp;
    }

    return undefined;
}

/**
 * Get user agent from request
 *
 * @param headers - Request headers
 * @returns User agent or undefined
 */
export function getUserAgent(headers: Record<string, string | string[] | undefined>): string | undefined {
    const userAgent = headers['user-agent'];
    if (!userAgent) return undefined;
    return Array.isArray(userAgent) ? userAgent[0] : userAgent;
}
