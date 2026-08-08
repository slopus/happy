import { AuthCredentials } from '@/auth/tokenStorage';
import { backoff } from '@/utils/time';
import { getServerUrl } from './serverConfig';
import { getHappyClientId } from './apiSocket';

type RegisterSuccessResponse = { success: true };

type RegisterTaskResponse = {
    taskId: string;
    state: 'accepted' | 'running' | 'succeeded' | 'failed';
    stage: string;
    pollAfterMs: number;
    heartbeatAt: string;
    updatedAt: string;
    error?: string;
};

function isRegisterTaskResponse(data: unknown): data is RegisterTaskResponse {
    return Boolean(
        data &&
        typeof data === 'object' &&
        'taskId' in data &&
        typeof (data as RegisterTaskResponse).taskId === 'string'
    );
}

async function waitForRegisterTask(credentials: AuthCredentials, initialTask: RegisterTaskResponse, apiEndpoint: string): Promise<void> {
    while (true) {
        const response = await fetch(`${apiEndpoint}/v1/tasks/${initialTask.taskId}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json'
            }
        });

        if (response.status === 404) {
            throw new Error('Service connection task was lost before completion. Please retry.');
        }

        if (!response.ok) {
            throw new Error(`Failed to poll service connection task: ${response.status}`);
        }

        const status = await response.json() as RegisterTaskResponse;
        if (status.state === 'succeeded') {
            return;
        }
        if (status.state === 'failed') {
            throw new Error(status.error || 'Failed to connect service account');
        }

        await new Promise((resolve) => setTimeout(resolve, status.pollAfterMs || 500));
    }
}

/**
 * Connect a service to the user's account
 */
export async function connectService(
    credentials: AuthCredentials,
    service: string,
    token: any
): Promise<void> {
    const API_ENDPOINT = getServerUrl();

    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/connect/${service}/register`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': getHappyClientId(),
            },
            body: JSON.stringify({ token: JSON.stringify(token) })
        });

        if (!response.ok) {
            throw new Error(`Failed to connect ${service}: ${response.status}`);
        }

        const data = await response.json() as RegisterSuccessResponse | RegisterTaskResponse;
        if (isRegisterTaskResponse(data)) {
            await waitForRegisterTask(credentials, data, API_ENDPOINT);
            return;
        }

        if (!data.success) {
            throw new Error(`Failed to connect ${service} account`);
        }
    });
}

/**
 * Disconnect a connected service from the user's account
 */
export async function disconnectService(credentials: AuthCredentials, service: string): Promise<void> {
    const API_ENDPOINT = getServerUrl();

    return await backoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/v1/connect/${service}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'X-Happy-Client': getHappyClientId(),
            }
        });

        if (!response.ok) {
            if (response.status === 404) {
                const error = await response.json();
                throw new Error(error.error || `${service} account not connected`);
            }
            throw new Error(`Failed to disconnect ${service}: ${response.status}`);
        }

        const data = await response.json() as { success: true };
        if (!data.success) {
            throw new Error(`Failed to disconnect ${service} account`);
        }
    });
}
