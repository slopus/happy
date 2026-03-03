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
    PublicShareNotFoundError,
    ConsentRequiredError,
    ShareNotFoundError,
    SessionSharingError
} from './sharingTypes';

/**
 * Upload content public key and binding signature to server
 */
export async function uploadContentPublicKey(
    credentials: AuthCredentials,
    contentPublicKey: string,
    contentPublicKeySig: string
): Promise<void> {
    const API_ENDPOINT = getServerUrl();

    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/user/content-key`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ contentPublicKey, contentPublicKeySig })
        });

        if (!response.ok) {
            throw new Error(`Failed to upload content public key: ${response.status}`);
        }
    });
}

/**
 * Get all shares for a session
 */
export async function getSessionShares(
    credentials: AuthCredentials,
    sessionId: string
): Promise<SessionShare[]> {
    const API_ENDPOINT = getServerUrl();

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
 */
export async function createSessionShare(
    credentials: AuthCredentials,
    sessionId: string,
    request: CreateSessionShareRequest
): Promise<SessionShare> {
    const API_ENDPOINT = getServerUrl();

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
 */
export async function updateSessionShare(
    credentials: AuthCredentials,
    sessionId: string,
    shareId: string,
    accessLevel: 'view' | 'edit' | 'admin'
): Promise<SessionShare> {
    const API_ENDPOINT = getServerUrl();

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
 */
export async function deleteSessionShare(
    credentials: AuthCredentials,
    sessionId: string,
    shareId: string
): Promise<void> {
    const API_ENDPOINT = getServerUrl();

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
 * Get public share info for a session
 */
export async function getPublicShare(
    credentials: AuthCredentials,
    sessionId: string
): Promise<PublicSessionShare | null> {
    const API_ENDPOINT = getServerUrl();

    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/sessions/${sessionId}/public-share`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
            }
        });

        if (!response.ok) {
            if (response.status === 404) {
                return null;
            }
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
 * Create or update a public share link for a session
 */
export async function createPublicShare(
    credentials: AuthCredentials,
    sessionId: string,
    request: CreatePublicShareRequest & { token: string }
): Promise<PublicSessionShare> {
    const API_ENDPOINT = getServerUrl();

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
 * Delete public share (disable public link)
 */
export async function deletePublicShare(
    credentials: AuthCredentials,
    sessionId: string
): Promise<void> {
    const API_ENDPOINT = getServerUrl();

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
 * Fetch messages from a public share (public endpoint, no auth required)
 */
export async function getPublicShareMessages(
    serverUrl: string,
    token: string,
    consent?: boolean
): Promise<{ id: string; seq: number; content: { t: string; c: string }; localId: string | null; createdAt: number; updatedAt: number }[]> {
    return await backoff(async () => {
        const url = new URL(`${serverUrl}/v1/public-share/${token}/messages`);
        if (consent) {
            url.searchParams.set('consent', 'true');
        }

        const response = await fetch(url.toString(), {
            method: 'GET',
        });

        if (!response.ok) {
            if (response.status === 404) {
                throw new PublicShareNotFoundError();
            }
            if (response.status === 403) {
                const body = await response.json();
                if (body.requiresConsent) {
                    throw new ConsentRequiredError();
                }
            }
            throw new Error(`Failed to get public share messages: ${response.status}`);
        }

        const data = await response.json();
        return data.messages;
    });
}

/**
 * Access a session via a public share token (public endpoint, no auth required)
 */
export async function accessPublicShare(
    serverUrl: string,
    token: string,
    consent?: boolean
): Promise<AccessPublicShareResponse> {
    return await backoff(async () => {
        const url = new URL(`${serverUrl}/v1/public-share/${token}`);
        if (consent) {
            url.searchParams.set('consent', 'true');
        }

        const response = await fetch(url.toString(), {
            method: 'GET',
        });

        if (!response.ok) {
            if (response.status === 404) {
                throw new PublicShareNotFoundError();
            }
            if (response.status === 403) {
                const body = await response.json();
                if (body.requiresConsent) {
                    throw new ConsentRequiredError();
                }
            }
            throw new Error(`Failed to access public share: ${response.status}`);
        }

        return await response.json();
    });
}
