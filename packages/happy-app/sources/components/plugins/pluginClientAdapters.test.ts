import type { PluginCatalogItem, PluginViewSurface } from '@slopus/happy-wire';
import { describe, expect, it } from 'vitest';

import {
    createPluginClientHost,
    resolveInstalledPluginEntrypoint,
    resolveInstalledPluginSurfaceViews,
    resolveInstalledPluginView,
} from './pluginClientAdapters';

function catalogItem(
    id: 'relationship-advisor' | 'generated-images-gallery',
    installed = true,
): PluginCatalogItem {
    const relationshipAdvisor = id === 'relationship-advisor';
    const version = '1.0.0';
    const permissions = relationshipAdvisor
        ? ['paws.ai.provider.invoke' as const, 'paws.secrets.use' as const]
        : ['paws.conversations.images.read' as const];
    return {
        manifest: {
            schemaVersion: 2,
            hostApiVersion: 1,
            id,
            version,
            title: { default: id },
            description: { default: id },
            icon: relationshipAdvisor ? 'chatbubbles-outline' : 'albums-outline',
            featured: true,
            installedAction: relationshipAdvisor ? 'configure' : 'open',
            permissions,
            entrypoint: {
                type: 'view',
                viewId: relationshipAdvisor
                    ? 'relationship-advisor.chat'
                    : 'generated-images-gallery.browser',
            },
            contributes: {
                views: relationshipAdvisor
                    ? [
                        view('relationship-advisor.chat', 'page'),
                        view('relationship-advisor.history', 'left-sidebar'),
                        view('relationship-advisor.configuration', 'modal'),
                    ]
                    : [
                        view('generated-images-gallery.browser', 'page'),
                        view('generated-images-gallery.session-images', 'right-panel'),
                    ],
            },
            configuration: { fields: [] },
        },
        status: installed
            ? { installed: true, version, grantedPermissions: [...permissions], configuration: {}, secretHints: {} }
            : { installed: false },
    };
}

function view(id: string, surface: PluginViewSurface) {
    return { id, surface, title: { default: id } };
}

describe('Paws plugin host client adapters', () => {
    it('resolves installed page entrypoints through bundled trusted adapters', () => {
        expect(resolveInstalledPluginEntrypoint(catalogItem('relationship-advisor'))).toMatchObject({
            path: '/relationship-advisor',
            viewId: 'relationship-advisor.chat',
        });
        expect(resolveInstalledPluginEntrypoint(catalogItem('generated-images-gallery'))).toMatchObject({
            path: '/generated-images',
            viewId: 'generated-images-gallery.browser',
        });
    });

    it('exposes installed contributions on left, right, and modal surfaces', () => {
        const plugins = [catalogItem('relationship-advisor'), catalogItem('generated-images-gallery')];

        expect(resolveInstalledPluginSurfaceViews(plugins, 'left-sidebar').map((view) => view.viewId))
            .toEqual(['relationship-advisor.history']);
        expect(resolveInstalledPluginSurfaceViews(plugins, 'right-panel').map((view) => view.viewId))
            .toEqual(['generated-images-gallery.session-images']);
        expect(resolveInstalledPluginSurfaceViews(plugins, 'modal').map((view) => view.viewId))
            .toEqual(['relationship-advisor.configuration']);
    });

    it('retracts every contribution immediately when a plugin is uninstalled or stale', () => {
        const uninstalled = catalogItem('relationship-advisor', false);
        const stale = catalogItem('generated-images-gallery');
        if (stale.status.installed) stale.status.version = '0.9.0';

        expect(resolveInstalledPluginSurfaceViews([uninstalled, stale], 'left-sidebar')).toEqual([]);
        expect(resolveInstalledPluginSurfaceViews([uninstalled, stale], 'right-panel')).toEqual([]);
        expect(resolveInstalledPluginEntrypoint(uninstalled)).toBeNull();
    });

    it('rejects unknown, mismatched, and undeclared view adapters', () => {
        const advisor = catalogItem('relationship-advisor');

        expect(resolveInstalledPluginView(advisor, 'generated-images-gallery.browser', 'page')).toBeNull();
        expect(resolveInstalledPluginView(advisor, 'relationship-advisor.history', 'page')).toBeNull();
        expect(resolveInstalledPluginView(advisor, 'relationship-advisor.unknown', 'modal')).toBeNull();
    });

    it('does not activate a declared modal before installation', () => {
        const advisor = catalogItem('relationship-advisor', false);

        expect(resolveInstalledPluginView(
            advisor,
            'relationship-advisor.configuration',
            'modal',
        )).toBeNull();
    });

    it('fails closed when a trusted adapter requires an undeclared capability', () => {
        const gallery = catalogItem('generated-images-gallery');
        gallery.manifest.permissions = [];

        expect(resolveInstalledPluginEntrypoint(gallery)).toBeNull();
        expect(resolveInstalledPluginSurfaceViews([gallery], 'right-panel')).toEqual([]);
    });

    it('fails closed when a trusted adapter capability was declared but not granted', () => {
        const gallery = catalogItem('generated-images-gallery');
        if (gallery.status.installed) gallery.status.grantedPermissions = [];

        expect(resolveInstalledPluginEntrypoint(gallery)).toBeNull();
        expect(resolveInstalledPluginSurfaceViews([gallery], 'right-panel')).toEqual([]);
    });

    it('registers and disposes a trusted Adapter as one reversible activation effect', () => {
        const host = createPluginClientHost();
        const plugin = {
            ...catalogItem('generated-images-gallery'),
            manifest: {
                ...catalogItem('generated-images-gallery').manifest,
                id: 'example-plugin',
                entrypoint: { type: 'view' as const, viewId: 'example-plugin.page' },
                contributes: {
                    views: [view('example-plugin.page', 'page')],
                },
            },
        } as PluginCatalogItem;

        const registration = host.register({
            pluginId: 'example-plugin',
            views: {
                'example-plugin.page': { surface: 'page', path: '/example-plugin' },
            },
        });
        expect(host.resolveEntrypoint(plugin)).toMatchObject({ path: '/example-plugin' });

        registration.dispose();
        registration.dispose();
        expect(host.resolveEntrypoint(plugin)).toBeNull();
    });
});
