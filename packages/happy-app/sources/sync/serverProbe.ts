export type ServerCheckResult = 'ok' | 'serverError' | 'notHappyServer' | 'unreachable';

const GREETING = 'Welcome to Happy Server!';
const HEALTH_SERVICE = 'happy-server';

/**
 * Checks that a URL is a Happy Server before the app switches to it. Same test
 * as happy-ios's ServerProbe: a GET whose text includes the greeting, or else a
 * /health that names happy-server.
 */
export async function probeHappyServer(url: string, fetchImplementation: typeof fetch = fetch): Promise<ServerCheckResult> {
    let response: Response;
    try {
        response = await fetchImplementation(url, { method: 'GET', headers: { 'Accept': 'text/plain' } });
    } catch {
        return 'unreachable';
    }
    if (!response.ok) {
        return 'serverError';
    }
    if ((await response.text()).includes(GREETING)) {
        return 'ok';
    }
    // happy-server-self-host serves the web app, so its / answers with the app's
    // HTML instead of the greeting. Its /health still names the server.
    return await reportsHappyServerHealth(url, fetchImplementation) ? 'ok' : 'notHappyServer';
}

async function reportsHappyServerHealth(url: string, fetchImplementation: typeof fetch): Promise<boolean> {
    try {
        const response = await fetchImplementation(`${url.replace(/\/+$/, '')}/health`, { method: 'GET', headers: { 'Accept': 'application/json' } });
        if (!response.ok) {
            return false;
        }
        const health = await response.json() as { service?: unknown };
        return health.service === HEALTH_SERVICE;
    } catch {
        return false;
    }
}
