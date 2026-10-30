import { describe, expect, it } from 'vitest';
import { probeHappyServer } from './serverProbe';

type Route = { status: number; body: string } | 'unreachable';

function fakeFetch(routes: Record<string, Route>) {
    const requestedUrls: string[] = [];
    const fetchImplementation = (async (input: RequestInfo | URL) => {
        const url = String(input);
        requestedUrls.push(url);
        const route = routes[url] ?? { status: 404, body: '{"error":"Not found"}' };
        if (route === 'unreachable') {
            throw new TypeError('Network request failed');
        }
        return new Response(route.body, { status: route.status });
    }) as typeof fetch;
    return { fetchImplementation, requestedUrls };
}

const healthy = JSON.stringify({ status: 'ok', timestamp: '2026-10-30T00:00:00.000Z', service: 'happy-server' });

describe('probeHappyServer', () => {
    it('accepts the greeting without asking /health', async () => {
        const { fetchImplementation, requestedUrls } = fakeFetch({
            'https://happy.example.com': { status: 200, body: 'Welcome to Happy Server!' },
        });
        expect(await probeHappyServer('https://happy.example.com', fetchImplementation)).toBe('ok');
        expect(requestedUrls).toEqual(['https://happy.example.com']);
    });

    it('accepts a self-hosted server whose / serves the web app', async () => {
        const { fetchImplementation } = fakeFetch({
            'https://happy.example.com/': { status: 200, body: '<!DOCTYPE html><html></html>' },
            'https://happy.example.com/health': { status: 200, body: healthy },
        });
        expect(await probeHappyServer('https://happy.example.com/', fetchImplementation)).toBe('ok');
    });

    it('rejects a server whose /health names another service', async () => {
        const { fetchImplementation } = fakeFetch({
            'https://other.example.com': { status: 200, body: '<html>nginx</html>' },
            'https://other.example.com/health': { status: 200, body: '{"status":"ok","service":"something-else"}' },
        });
        expect(await probeHappyServer('https://other.example.com', fetchImplementation)).toBe('notHappyServer');
    });

    it('rejects a server without a /health', async () => {
        const { fetchImplementation } = fakeFetch({
            'https://other.example.com': { status: 200, body: '<html>nginx</html>' },
        });
        expect(await probeHappyServer('https://other.example.com', fetchImplementation)).toBe('notHappyServer');
    });

    it('reports a non-2xx answer and an unreachable host', async () => {
        const { fetchImplementation } = fakeFetch({
            'https://broken.example.com': { status: 502, body: 'Bad Gateway' },
            'https://offline.example.com': 'unreachable',
        });
        expect(await probeHappyServer('https://broken.example.com', fetchImplementation)).toBe('serverError');
        expect(await probeHappyServer('https://offline.example.com', fetchImplementation)).toBe('unreachable');
    });
});
