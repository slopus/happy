import { beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => vi.fn());
vi.mock('./apiSocket', () => ({ apiSocket: { request } }));

import {
    getPluginCatalog,
    installPlugin,
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
    permissions: [],
    entrypoint: { type: 'view', viewId: 'sample-plugin.page' },
    contributes: {
        views: [{ id: 'sample-plugin.page', surface: 'page', title: { default: 'Sample' } }],
    },
    configuration: { fields: [] },
};

describe('dynamic plugin client', () => {
    beforeEach(() => vi.clearAllMocks());

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
                installed: true, version: '2.1.0', configuration: {}, secretHints: {},
            }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ installed: false }), { status: 200 }));

        await installPlugin('sample-plugin', '2.1.0', { token: 'secret' });
        await uninstallPlugin('sample-plugin');

        expect(request).toHaveBeenNthCalledWith(1, '/v1/plugins/sample-plugin', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ version: '2.1.0', configuration: { token: 'secret' } }),
        });
        expect(request).toHaveBeenNthCalledWith(2, '/v1/plugins/sample-plugin', { method: 'DELETE' });
    });
});
