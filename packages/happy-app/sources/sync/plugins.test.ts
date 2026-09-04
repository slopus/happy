import { beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => vi.fn());
vi.mock('./apiSocket', () => ({ apiSocket: { request } }));

import {
    getPluginCatalog,
    installPlugin,
    revealPluginSecret,
    testPluginConnection,
    uninstallPlugin,
} from './plugins';

const manifest = {
    schemaVersion: 2,
    hostApiVersion: 1,
    id: 'sample-plugin',
    version: '2.1.0',
    title: { default: 'Sample' },
    description: { default: 'From the server' },
    icon: 'apps-outline',
    featured: true,
    installedAction: 'open',
    permissions: ['paws.secrets.use'],
    entrypoint: { type: 'view', viewId: 'sample-plugin.page' },
    contributes: {
        views: [{ id: 'sample-plugin.page', surface: 'page', title: { default: 'Sample' } }],
    },
    configuration: { fields: [] },
};

describe('dynamic plugin client', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
    });

    it('loads the server-owned catalog instead of a bundled list', async () => {
        request.mockResolvedValue(new Response(JSON.stringify({
            plugins: [{ manifest, status: { installed: false } }],
        }), { status: 200 }));

        await expect(getPluginCatalog()).resolves.toEqual({
            plugins: [{ manifest, status: { installed: false } }],
        });
        expect(request).toHaveBeenCalledWith('/v1/plugins');
    });

    it('pins the manifest version when installing and supports generic uninstall', async () => {
        request
            .mockResolvedValueOnce(new Response(JSON.stringify({
                installed: true,
                version: '2.1.0',
                grantedPermissions: ['paws.secrets.use'],
                configuration: {},
                secretHints: {},
            }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ installed: false }), { status: 200 }));

        await installPlugin('sample-plugin', '2.1.0', { token: 'secret' }, ['paws.secrets.use']);
        await uninstallPlugin('sample-plugin');

        expect(request).toHaveBeenNthCalledWith(1, '/v1/plugins/sample-plugin', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                version: '2.1.0',
                grantedPermissions: ['paws.secrets.use'],
                configuration: { token: 'secret' },
            }),
        });
        expect(request).toHaveBeenNthCalledWith(2, '/v1/plugins/sample-plugin', { method: 'DELETE' });
    });

    it('tests current configuration without installing it', async () => {
        request.mockResolvedValue(new Response(JSON.stringify({ success: true, latencyMs: 27 }), { status: 200 }));

        await expect(testPluginConnection('sample-plugin', '2.1.0', {
            token: 'secret',
        }, ['paws.secrets.use'])).resolves.toEqual({ success: true, latencyMs: 27 });

        expect(request).toHaveBeenCalledWith('/v1/plugins/sample-plugin/test-connection', expect.objectContaining({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                version: '2.1.0',
                grantedPermissions: ['paws.secrets.use'],
                configuration: { token: 'secret' },
            }),
            signal: expect.any(AbortSignal),
        }));
    });

    it('returns a timed-out connection result when the server request does not settle', async () => {
        vi.useFakeTimers();
        request.mockImplementation((_path: string, options?: RequestInit) => new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => {
                const error = new Error('Aborted');
                error.name = 'AbortError';
                reject(error);
            });
        }));

        const pending = testPluginConnection('sample-plugin', '2.1.0', {
            token: 'secret',
        }, ['paws.secrets.use']);
        await vi.runAllTimersAsync();

        await expect(pending).resolves.toEqual({ success: false, code: 'timed_out' });
        vi.useRealTimers();
    });

    it('requests one stored plugin secret from the no-store reveal endpoint', async () => {
        request.mockResolvedValue(new Response(JSON.stringify({ value: 'sk-secret-1234' }), { status: 200 }));

        await expect(revealPluginSecret('sample-plugin', 'token')).resolves.toBe('sk-secret-1234');

        expect(request).toHaveBeenCalledWith('/v1/plugins/sample-plugin/secrets/token/reveal', {
            method: 'POST',
        });
    });
});
