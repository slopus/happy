export type ServerConnectionValidationResult =
    | { valid: true }
    | { valid: false; reason: 'server-error' | 'not-happy-server' | 'connection-failed' };

export async function validateHappyServerConnection(
    serverUrl: string,
    fetcher: typeof fetch = fetch,
): Promise<ServerConnectionValidationResult> {
    const baseUrl = serverUrl.trim().replace(/\/+$/, '');

    let response: Response;
    try {
        response = await fetcher(`${baseUrl}/health`, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
            },
        });
    } catch {
        return { valid: false, reason: 'connection-failed' };
    }

    if (!response.ok) {
        return { valid: false, reason: 'server-error' };
    }

    try {
        const body = await response.json() as { status?: unknown; service?: unknown };
        if (body.status === 'ok' && body.service === 'happy-server') {
            return { valid: true };
        }
        return { valid: false, reason: 'not-happy-server' };
    } catch {
        return { valid: false, reason: 'not-happy-server' };
    }
}
