import { AuthCredentials } from '@/auth/tokenStorage';
import { backoff } from '@/utils/time';
import { getServerUrl } from './serverConfig';
import {
    SessionShare,
    SessionShareResponse,
    SessionSharesResponse,
    CreateSessionShareRequest,
    ShareNotFoundError,
    SessionSharingError
} from './sharingTypes';

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
