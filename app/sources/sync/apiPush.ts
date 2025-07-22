import { AuthCredentials } from '@/auth/tokenStorage';
import { backoff } from '@/utils/time';

const API_ENDPOINT = process.env.EXPO_PUBLIC_API_ENDPOINT || 'https://handy-api.korshakov.org';

export async function registerPushToken(credentials: AuthCredentials, token: string): Promise<void> {
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