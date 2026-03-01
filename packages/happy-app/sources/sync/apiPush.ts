import { AuthCredentials } from '@/auth/tokenStorage';
import { backoff } from '@/utils/time';
import { getServerUrl } from './serverConfig';

export async function registerPushToken(credentials: AuthCredentials, token: string): Promise<void> {
    const API_ENDPOINT = getServerUrl();
    await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/push-tokens`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ token })
        });

        if (!response.ok) {
            throw new Error(`Failed to register push token: ${response.status}`);
        }

        const data = await response.json();
        if (!data.success) {
            throw new Error('Failed to register push token');
        }
    });
}

export async function resetBadgeCount(credentials: AuthCredentials): Promise<void> {
    const API_ENDPOINT = getServerUrl();
    try {
        await fetch(`${API_ENDPOINT}/v1/badge/reset`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json'
            }
        });
    } catch {
        // Best-effort: don't block app lifecycle if server is unreachable
    }
}