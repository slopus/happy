import { getServerUrl } from './serverConfig';
import { TokenStorage } from '@/auth/tokenStorage';

interface ShareMessage {
    role: 'user' | 'assistant';
    text: string;
}

interface ShareResponse {
    id: string;
    url: string;
}

interface SharedSessionData {
    id: string;
    title: string;
    messages: ShareMessage[];
    createdAt: string;
}

export async function createSharedSession(args: {
    title: string;
    sessionId?: string;
    messages: ShareMessage[];
}): Promise<ShareResponse> {
    const serverUrl = getServerUrl();
    const credentials = await TokenStorage.getCredentials();
    if (!credentials) {
        throw new Error('No authentication credentials');
    }

    const response = await fetch(`${serverUrl}/v1/share`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${credentials.token}`,
        },
        body: JSON.stringify(args),
    });

    if (!response.ok) {
        throw new Error(`Failed to share: ${response.status}`);
    }

    return response.json();
}

export async function getSharedSession(id: string): Promise<SharedSessionData> {
    const serverUrl = getServerUrl();

    const response = await fetch(`${serverUrl}/v1/share/${id}`);

    if (!response.ok) {
        throw new Error(`Shared session not found`);
    }

    return response.json();
}
