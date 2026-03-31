import axios from 'axios';

const BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3005';

export const api = axios.create({
    baseURL: BASE_URL,
    headers: { 'Content-Type': 'application/json' }
});

/**
 * Set the auth token for all API requests.
 */
export function setAuthToken(token: string | null) {
    if (token) {
        api.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    } else {
        delete api.defaults.headers.common['Authorization'];
    }
}

async function fetchDevToken(): Promise<string | null> {
    try {
        const res = await axios.post(`${BASE_URL}/v1/auth/dev-token`);
        return res.data.token as string;
    } catch {
        console.warn('Dev auth unavailable — set DEV_AUTH_ENABLED=true on the server');
        return null;
    }
}

let devAuthPromise: Promise<void> | null = null;

/**
 * Fetch a dev token from the server's DEV_AUTH_ENABLED endpoint.
 * Caches the token in sessionStorage so it survives page refreshes.
 */
export function ensureDevAuth(): Promise<void> {
    if (devAuthPromise) return devAuthPromise;
    devAuthPromise = (async () => {
        const stored = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('dev_token') : null;
        if (stored) {
            setAuthToken(stored);
            return;
        }
        const token = await fetchDevToken();
        if (token) {
            setAuthToken(token);
            if (typeof sessionStorage !== 'undefined') {
                sessionStorage.setItem('dev_token', token);
            }
        }
    })();
    return devAuthPromise;
}

// Auto-retry on 401: clear stale token, fetch a fresh one, replay the request
api.interceptors.response.use(undefined, async (error) => {
    const original = error.config;
    if (error.response?.status === 401 && !original._retried) {
        original._retried = true;
        if (typeof sessionStorage !== 'undefined') {
            sessionStorage.removeItem('dev_token');
        }
        devAuthPromise = null;
        const token = await fetchDevToken();
        if (token) {
            setAuthToken(token);
            if (typeof sessionStorage !== 'undefined') {
                sessionStorage.setItem('dev_token', token);
            }
            original.headers['Authorization'] = `Bearer ${token}`;
            return api(original);
        }
    }
    return Promise.reject(error);
});
