import { AuthCredentials } from '@/auth/tokenStorage';
import { backoff } from '@/utils/time';
import { HappyError } from '@/utils/errors';
import { getServerUrl } from './serverConfig';

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
 * Get GitHub OAuth parameters from the server
 */
export async function getGitHubOAuthParams(credentials: AuthCredentials): Promise<GitHubOAuthParams> {
    const API_ENDPOINT = getServerUrl();
    
    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/connect/github/params`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            if (response.status === 400) {
                let message = 'GitHub OAuth not configured';
                try {
                    const error = await response.json();
                    if (error?.error) message = error.error;
                } catch {
                    // ignore
                }
                throw new HappyError(message, false, { status: 400, kind: 'config' });
            }
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                let message = 'Failed to get GitHub OAuth params';
                try {
                    const error = await response.json();
                    if (error?.error) message = error.error;
                } catch {
                    // ignore
                }
                throw new HappyError(message, false, { status: response.status, kind: response.status === 401 || response.status === 403 ? 'auth' : 'config' });
            }
            throw new Error(`Failed to get GitHub OAuth params: ${response.status}`);
        }

        const data = await response.json() as GitHubOAuthParams;
        return data;
    });
}

/**
 * Get account profile including GitHub connection status
 */
export async function getAccountProfile(credentials: AuthCredentials): Promise<AccountProfile> {
    const API_ENDPOINT = getServerUrl();
    
    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/account/profile`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                let message = 'Failed to get account profile';
                try {
                    const error = await response.json();
                    if (error?.error) message = error.error;
                } catch {
                    // ignore
                }
                throw new HappyError(message, false, { status: response.status, kind: response.status === 401 || response.status === 403 ? 'auth' : 'config' });
            }
            throw new Error(`Failed to get account profile: ${response.status}`);
        }

        const data = await response.json() as AccountProfile;
        return data;
    });
}

/**
 * Disconnect GitHub account from the user's profile
 */
export async function disconnectGitHub(credentials: AuthCredentials): Promise<void> {
    const API_ENDPOINT = getServerUrl();
    
    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/connect/github`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${credentials.token}`
            }
        });

        if (!response.ok) {
            if (response.status === 404) {
                let message = 'GitHub account not connected';
                try {
                    const error = await response.json();
                    if (error?.error) message = error.error;
                } catch {
                    // ignore
                }
                throw new HappyError(message, false, { status: 404, kind: 'config' });
            }
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
                let message = 'Failed to disconnect GitHub';
                try {
                    const error = await response.json();
                    if (error?.error) message = error.error;
                } catch {
                    // ignore
                }
                throw new HappyError(message, false, { status: response.status, kind: response.status === 401 || response.status === 403 ? 'auth' : 'config' });
            }
            throw new Error(`Failed to disconnect GitHub: ${response.status}`);
        }

        const data = await response.json() as { success: true };
        if (!data.success) {
            throw new Error('Failed to disconnect GitHub account');
        }
    });
}
