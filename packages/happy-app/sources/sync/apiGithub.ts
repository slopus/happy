import { AuthCredentials } from '@/auth/tokenStorage';
import { backoff } from '@/utils/time';
import { HappyError } from '@/utils/errors';
import { getServerUrl } from './serverConfig';
import { getHappyClientId } from './apiSocket';

export interface GitHubOAuthParams {
    url: string;
}

export interface GitHubProfile {
    id: number;
    login: string;
    name: string;
    avatar_url: string;
    email?: string;
}

export interface AccountProfile {
    id: string;
    timestamp: number;
    github: GitHubProfile | null;
}

/**
 * Fetch inside backoff(), retrying only network errors, 5xx and 429.
 * Any other answer is returned: a 4xx (for example the 400 a server without
 * GitHub OAuth configured gives) will not change on retry, so the callers
 * report it once instead of polling the server forever.
 */
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    return await backoff(async () => {
        const response = await fetch(url, init);
        if (response.status >= 500 || response.status === 429) {
            throw new Error(`Request to ${url} failed: ${response.status}`);
        }
        return response;
    });
}

/**
 * Get GitHub OAuth parameters from the server
 */
export async function getGitHubOAuthParams(credentials: AuthCredentials): Promise<GitHubOAuthParams> {
    const API_ENDPOINT = getServerUrl();

    const response = await fetchWithRetry(`${API_ENDPOINT}/v1/connect/github/params`, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'Content-Type': 'application/json',
            'X-Happy-Client': getHappyClientId(),
        }
    });

    if (!response.ok) {
        if (response.status === 400) {
            const error = await response.json();
            throw new HappyError(error.error || 'GitHub OAuth not configured', false);
        }
        throw new HappyError(`Failed to get GitHub OAuth params: ${response.status}`, false);
    }

    const data = await response.json() as GitHubOAuthParams;
    return data;
}

/**
 * Get account profile including GitHub connection status
 */
export async function getAccountProfile(credentials: AuthCredentials): Promise<AccountProfile> {
    const API_ENDPOINT = getServerUrl();

    const response = await fetchWithRetry(`${API_ENDPOINT}/v1/account/profile`, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'Content-Type': 'application/json',
            'X-Happy-Client': getHappyClientId(),
        }
    });

    if (!response.ok) {
        throw new HappyError(`Failed to get account profile: ${response.status}`, false);
    }

    const data = await response.json() as AccountProfile;
    return data;
}

/**
 * Disconnect GitHub account from the user's profile
 */
export async function disconnectGitHub(credentials: AuthCredentials): Promise<void> {
    const API_ENDPOINT = getServerUrl();

    const response = await fetchWithRetry(`${API_ENDPOINT}/v1/connect/github`, {
        method: 'DELETE',
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'X-Happy-Client': getHappyClientId(),
        }
    });

    if (!response.ok) {
        if (response.status === 404) {
            const error = await response.json();
            throw new HappyError(error.error || 'GitHub account not connected', false);
        }
        throw new HappyError(`Failed to disconnect GitHub: ${response.status}`, false);
    }

    const data = await response.json() as { success: true };
    if (!data.success) {
        throw new HappyError('Failed to disconnect GitHub account', false);
    }
}
