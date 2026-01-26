import { AuthCredentials } from '@/auth/tokenStorage';
import { backoff } from '@/utils/time';
import { getServerUrl } from './serverConfig';
import {
    SessionShare,
    SessionShareResponse,
    SessionSharesResponse,
    CreateSessionShareRequest,
    PublicSessionShare,
    PublicShareResponse,
    CreatePublicShareRequest,
    AccessPublicShareResponse,
    SharedSessionsResponse,
    SessionWithShareResponse,
    PublicShareAccessLogsResponse,
    PublicShareBlockedUsersResponse,
    BlockPublicShareUserRequest,
    ShareNotFoundError,
    PublicShareNotFoundError,
    ConsentRequiredError,
    SessionSharingError
} from './sharingTypes';

const API_ENDPOINT = getServerUrl();

/**
 * Get all shares for a session
 *
 * @param credentials - User authentication credentials
 * @param sessionId - ID of the session to get shares for
 * @returns List of all shares for the session
 * @throws {SessionSharingError} If the user doesn't have permission (not owner/admin)
 * @throws {Error} For other API errors
 *
 * @remarks
 * Only the session owner or users with admin access can view all shares.
 * The returned shares include information about who has access and their
 * access levels.
 */
export async function getSessionShares(
    credentials: AuthCredentials,
    sessionId: string
): Promise<SessionShare[]> {
    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/sessions/${sessionId}/shares`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
            }
        });

        if (!response.ok) {
            if (response.status === 403) {
                throw new SessionSharingError('Forbidden');
            }
            throw new Error(`Failed to get session shares: ${response.status}`);
        }

        const data: SessionSharesResponse = await response.json();
        return data.shares;
    });
}

/**
 * Share a session with a specific user
 *
 * @param credentials - User authentication credentials
 * @param sessionId - ID of the session to share
 * @param request - Share creation request containing userId and accessLevel
 * @returns The created or updated share
 * @throws {SessionSharingError} If sharing fails (not friends, forbidden, etc.)
 * @throws {Error} For other API errors
 *
 * @remarks
 * Only the session owner or users with admin access can create shares.
 * The target user must be a friend of the owner. If a share already exists
 * for the user, it will be updated with the new access level.
 *
 * The client must provide `encryptedDataKey` (the session DEK wrapped for the
 * recipient's content public key). The server stores it as an opaque blob.
 */
export async function createSessionShare(
    credentials: AuthCredentials,
    sessionId: string,
    request: CreateSessionShareRequest
): Promise<SessionShare> {
    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/sessions/${sessionId}/shares`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(request)
        });

        if (!response.ok) {
            if (response.status === 403) {
                const error = await response.json();
                throw new SessionSharingError(error.error || 'Forbidden');
            }
            if (response.status === 400) {
                const error = await response.json();
                throw new SessionSharingError(error.error || 'Bad request');
            }
            throw new Error(`Failed to create session share: ${response.status}`);
        }

        const data: SessionShareResponse = await response.json();
        return data.share;
    });
}

/**
 * Update the access level of an existing share
 *
 * @param credentials - User authentication credentials
 * @param sessionId - ID of the session
 * @param shareId - ID of the share to update
 * @param accessLevel - New access level to grant
 * @returns The updated share
 * @throws {SessionSharingError} If the user doesn't have permission
 * @throws {ShareNotFoundError} If the share doesn't exist
 * @throws {Error} For other API errors
 *
 * @remarks
 * Only the session owner or users with admin access can update shares.
 */
export async function updateSessionShare(
    credentials: AuthCredentials,
    sessionId: string,
    shareId: string,
    accessLevel: 'view' | 'edit' | 'admin'
): Promise<SessionShare> {
    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/sessions/${sessionId}/shares/${shareId}`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ accessLevel })
        });

        if (!response.ok) {
            if (response.status === 403) {
                throw new SessionSharingError('Forbidden');
            }
            if (response.status === 404) {
                throw new ShareNotFoundError();
            }
            throw new Error(`Failed to update session share: ${response.status}`);
        }

        const data: SessionShareResponse = await response.json();
        return data.share;
    });
}

/**
 * Delete a share and revoke user access
 *
 * @param credentials - User authentication credentials
 * @param sessionId - ID of the session
 * @param shareId - ID of the share to delete
 * @throws {SessionSharingError} If the user doesn't have permission
 * @throws {ShareNotFoundError} If the share doesn't exist
 * @throws {Error} For other API errors
 *
 * @remarks
 * Only the session owner or users with admin access can delete shares.
 * The shared user will immediately lose access to the session.
 */
export async function deleteSessionShare(
    credentials: AuthCredentials,
    sessionId: string,
    shareId: string
): Promise<void> {
    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/sessions/${sessionId}/shares/${shareId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
            }
        });

        if (!response.ok) {
            if (response.status === 403) {
                throw new SessionSharingError('Forbidden');
            }
            if (response.status === 404) {
                throw new ShareNotFoundError();
            }
            throw new Error(`Failed to delete session share: ${response.status}`);
        }
    });
}

/**
 * Get all sessions shared with the current user
 *
 * @param credentials - User authentication credentials
 * @returns List of sessions that have been shared with the current user
 * @throws {Error} For API errors
 *
 * @remarks
 * Returns sessions where the current user has been granted access by other users.
 * Each entry includes the session metadata, who shared it, and the access level granted.
 */
export async function getSharedSessions(
    credentials: AuthCredentials
): Promise<SharedSessionsResponse> {
    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/shares/sessions`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to get shared sessions: ${response.status}`);
        }

        return await response.json();
    });
}

/**
 * Get shared session details with encrypted key
 */
export async function getSharedSessionDetails(
    credentials: AuthCredentials,
    sessionId: string
): Promise<SessionWithShareResponse> {
    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/shares/sessions/${sessionId}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
            }
        });

        if (!response.ok) {
            if (response.status === 403) {
                throw new SessionSharingError('Forbidden');
            }
            if (response.status === 404) {
                throw new ShareNotFoundError();
            }
            throw new Error(`Failed to get shared session details: ${response.status}`);
        }

        return await response.json();
    });
}

/**
 * Create or update a public share link for a session
 *
 * @param credentials - User authentication credentials
 * @param sessionId - ID of the session to share publicly
 * @param request - Public share configuration (expiration, limits, consent)
 * @returns The created or updated public share with its token
 * @throws {SessionSharingError} If the user doesn't have permission
 * @throws {Error} For other API errors
 *
 * @remarks
 * Only the session owner can create public shares. Public shares are always
 * read-only for security. If a public share already exists for the session,
 * it will be updated with the new settings.
 *
 * The returned `token` can be used to construct a public URL for sharing.
 */
export async function createPublicShare(
    credentials: AuthCredentials,
    sessionId: string,
    request: CreatePublicShareRequest & { token: string }
): Promise<PublicSessionShare> {
    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/sessions/${sessionId}/public-share`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(request)
        });

        if (!response.ok) {
            if (response.status === 403) {
                throw new SessionSharingError('Forbidden');
            }
            throw new Error(`Failed to create public share: ${response.status}`);
        }

        const data: PublicShareResponse = await response.json();
        return data.publicShare;
    });
}

/**
 * Get public share info for a session
 */
export async function getPublicShare(
    credentials: AuthCredentials,
    sessionId: string
): Promise<PublicSessionShare | null> {
    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/sessions/${sessionId}/public-share`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
            }
        });

        if (!response.ok) {
            if (response.status === 403) {
                throw new SessionSharingError('Forbidden');
            }
            throw new Error(`Failed to get public share: ${response.status}`);
        }

        const data: PublicShareResponse = await response.json();
        return data.publicShare;
    });
}

/**
 * Delete public share (disable public link)
 */
export async function deletePublicShare(
    credentials: AuthCredentials,
    sessionId: string
): Promise<void> {
    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/sessions/${sessionId}/public-share`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
            }
        });

        if (!response.ok) {
            if (response.status === 403) {
                throw new SessionSharingError('Forbidden');
            }
            throw new Error(`Failed to delete public share: ${response.status}`);
        }
    });
}

/**
 * Access a session via a public share token
 *
 * @param token - The public share token from the URL
 * @param consent - Whether the user consents to access logging (if required)
 * @param credentials - Optional user credentials for authenticated access
 * @returns Session data and encrypted key for decryption
 * @throws {PublicShareNotFoundError} If the token is invalid, expired, or max uses reached
 * @throws {ConsentRequiredError} If consent is required but not provided
 * @throws {SessionSharingError} For other access errors
 * @throws {Error} For other API errors
 *
 * @remarks
 * This endpoint does not require authentication, allowing anonymous access.
 * However, if credentials are provided, the user's identity will be logged.
 *
 * If the public share has `isConsentRequired` set to true, the `consent`
 * parameter must be true, or a ConsentRequiredError will be thrown.
 *
 * Public shares are always read-only access. The returned session includes
 * metadata and an encrypted data key for decrypting the session content.
 */
export async function accessPublicShare(
    token: string,
    consent?: boolean,
    credentials?: AuthCredentials
): Promise<AccessPublicShareResponse> {
    return await backoff(async () => {
        const url = new URL(`${API_ENDPOINT}/v1/public-share/${token}`);
        if (consent !== undefined) {
            url.searchParams.set('consent', consent.toString());
        }

        const headers: Record<string, string> = {};
        if (credentials) {
            headers['Authorization'] = `Bearer ${credentials.token}`;
        }

        const response = await fetch(url.toString(), {
            method: 'GET',
            headers
        });

        if (!response.ok) {
            if (response.status === 404) {
                throw new PublicShareNotFoundError();
            }
            if (response.status === 403) {
                const error = await response.json();
                if (error.requiresConsent) {
                    throw new ConsentRequiredError();
                }
                throw new SessionSharingError(error.error || 'Forbidden');
            }
            throw new Error(`Failed to access public share: ${response.status}`);
        }

        return await response.json();
    });
}

/**
 * Get blocked users for public share
 */
export async function getPublicShareBlockedUsers(
    credentials: AuthCredentials,
    sessionId: string
): Promise<PublicShareBlockedUsersResponse> {
    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/sessions/${sessionId}/public-share/blocked-users`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
            }
        });

        if (!response.ok) {
            if (response.status === 403) {
                throw new SessionSharingError('Forbidden');
            }
            if (response.status === 404) {
                throw new PublicShareNotFoundError();
            }
            throw new Error(`Failed to get blocked users: ${response.status}`);
        }

        return await response.json();
    });
}

/**
 * Block user from public share
 */
export async function blockPublicShareUser(
    credentials: AuthCredentials,
    sessionId: string,
    request: BlockPublicShareUserRequest
): Promise<void> {
    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/sessions/${sessionId}/public-share/blocked-users`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(request)
        });

        if (!response.ok) {
            if (response.status === 403) {
                throw new SessionSharingError('Forbidden');
            }
            if (response.status === 404) {
                throw new PublicShareNotFoundError();
            }
            throw new Error(`Failed to block user: ${response.status}`);
        }
    });
}

/**
 * Unblock user from public share
 */
export async function unblockPublicShareUser(
    credentials: AuthCredentials,
    sessionId: string,
    blockedUserId: string
): Promise<void> {
    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/sessions/${sessionId}/public-share/blocked-users/${blockedUserId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
            }
        });

        if (!response.ok) {
            if (response.status === 403) {
                throw new SessionSharingError('Forbidden');
            }
            throw new Error(`Failed to unblock user: ${response.status}`);
        }
    });
}

/**
 * Get access logs for public share
 */
export async function getPublicShareAccessLogs(
    credentials: AuthCredentials,
    sessionId: string,
    limit?: number
): Promise<PublicShareAccessLogsResponse> {
    return await backoff(async () => {
        const url = new URL(`${API_ENDPOINT}/v1/sessions/${sessionId}/public-share/access-logs`);
        if (limit !== undefined) {
            url.searchParams.set('limit', limit.toString());
        }

        const response = await fetch(url.toString(), {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
            }
        });

        if (!response.ok) {
            if (response.status === 403) {
                throw new SessionSharingError('Forbidden');
            }
            if (response.status === 404) {
                throw new PublicShareNotFoundError();
            }
            throw new Error(`Failed to get access logs: ${response.status}`);
        }

        return await response.json();
    });
}
