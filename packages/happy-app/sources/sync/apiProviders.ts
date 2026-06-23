import type { AuthCredentials } from '@/auth/tokenStorage';
import { getServerUrl } from './serverConfig';
import { getHappyClientId } from './apiSocket';

export interface CustomModelProvider {
    id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    modelName: string;
    agentFlavor: 'claude' | 'codex';
}

const KV_PREFIX = 'custom-provider:';

/**
 * Fetch all custom model providers from the happy-server KV store.
 */
export async function loadCustomProviders(credentials: AuthCredentials): Promise<CustomModelProvider[]> {
    const url = `${getServerUrl()}/v1/kv?prefix=${encodeURIComponent(KV_PREFIX)}&limit=100`;
    const response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'X-Happy-Client': getHappyClientId(),
        },
    });
    if (!response.ok) {
        throw new Error(`Failed to load providers: ${response.status}`);
    }
    const data = await response.json();
    return (data.items || []).map((item: { value: string }) => JSON.parse(item.value));
}

/**
 * Save (create or update) a custom model provider.
 * Uses optimistic concurrency with version=-1 to always accept.
 */
export async function saveCustomProvider(credentials: AuthCredentials, provider: CustomModelProvider): Promise<void> {
    const url = `${getServerUrl()}/v1/kv`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'Content-Type': 'application/json',
            'X-Happy-Client': getHappyClientId(),
        },
        body: JSON.stringify({
            mutations: [{
                key: `${KV_PREFIX}${provider.id}`,
                value: JSON.stringify(provider),
                version: -1,
            }],
        }),
    });
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Failed to save provider: ${response.status} ${body}`);
    }
}

/**
 * Delete a custom model provider by its id.
 */
export async function deleteCustomProvider(credentials: AuthCredentials, id: string): Promise<void> {
    const url = `${getServerUrl()}/v1/kv`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'Content-Type': 'application/json',
            'X-Happy-Client': getHappyClientId(),
        },
        body: JSON.stringify({
            mutations: [{
                key: `${KV_PREFIX}${id}`,
                value: null,
                version: -1,
            }],
        }),
    });
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Failed to delete provider: ${response.status} ${body}`);
    }
}
