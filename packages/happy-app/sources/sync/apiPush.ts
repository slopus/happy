import { AuthCredentials } from '@/auth/tokenStorage';
import { backoff, delay } from '@/utils/time';
import { z } from 'zod';
import { getServerUrl } from './serverConfig';
import { getHappyClientId } from './apiSocket';

const PushTokenSchema = z.object({
    id: z.string(),
    token: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
});

const PushTokenListResponseSchema = z.object({
    tokens: z.array(PushTokenSchema),
});

export type PushToken = z.infer<typeof PushTokenSchema>;

const PUSH_TOKEN_MUTATION_TIMEOUT_MS = 12_000;
const PUSH_TOKEN_MUTATION_MAX_ATTEMPTS = 3;

class PushTokenMutationHttpError extends Error {
    constructor(readonly status: number, action: string) {
        super(`Failed to ${action} push token with Paws server: HTTP ${status}`);
    }
}

async function mutatePushToken(credentials: AuthCredentials, method: 'POST' | 'DELETE', token: string): Promise<void> {
    const action = method === 'POST' ? 'register' : 'delete';
    const actionName = method === 'POST' ? 'registration' : 'deletion';
    const url = `${getServerUrl()}/v1/push-tokens${method === 'DELETE' ? `/${encodeURIComponent(token)}` : ''}`;
    for (let attempt = 1; attempt <= PUSH_TOKEN_MUTATION_MAX_ATTEMPTS; attempt++) {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const request = async () => {
                const response = await fetch(url, {
                    method,
                    headers: {
                        'Authorization': `Bearer ${credentials.token}`,
                        'Content-Type': 'application/json',
                        'X-Happy-Client': getHappyClientId(),
                    },
                    body: method === 'POST' ? JSON.stringify({ token }) : undefined,
                    signal: controller.signal,
                });
                if (!response.ok) {
                    throw new PushTokenMutationHttpError(response.status, action);
                }
                const data = await response.json();
                if (!data.success) {
                    throw new Error(`Paws server rejected the push token ${actionName}.`);
                }
            };

            await Promise.race([
                request(),
                new Promise<void>((_, reject) => {
                    timer = setTimeout(() => {
                        reject(new Error(`Paws server push token ${actionName} timed out after 12 seconds.`));
                        controller.abort();
                    }, PUSH_TOKEN_MUTATION_TIMEOUT_MS);
                }),
            ]);
            return;
        } catch (error) {
            if (timer) {
                clearTimeout(timer);
                timer = undefined;
            }
            if (error instanceof PushTokenMutationHttpError && error.status >= 400 && error.status < 500 && error.status !== 429) {
                throw error;
            }
            if (attempt === PUSH_TOKEN_MUTATION_MAX_ATTEMPTS) {
                throw error;
            }
            await delay(attempt * 500);
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
    }
}

export async function registerPushToken(credentials: AuthCredentials, token: string): Promise<void> {
    await mutatePushToken(credentials, 'POST', token);
}

export async function fetchPushTokens(credentials: AuthCredentials): Promise<PushToken[]> {
    const API_ENDPOINT = getServerUrl();
    return backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/push-tokens`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getHappyClientId(),
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch push tokens: ${response.status}`);
        }

        const data = await response.json();
        return PushTokenListResponseSchema.parse(data).tokens;
    });
}

export async function unregisterPushToken(credentials: AuthCredentials, token: string): Promise<void> {
    await mutatePushToken(credentials, 'DELETE', token);
}
