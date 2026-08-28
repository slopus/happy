import type {
    PluginCatalogItem,
    PluginPermission,
    PluginViewContribution,
    PluginViewSurface,
} from '@slopus/happy-wire';

export type PluginClientComponentId =
    | 'relationship-advisor-history'
    | 'plugin-configuration'
    | 'generated-images-session-images';

export type PluginClientViewAdapter = {
    surface: PluginViewSurface;
    path?: string;
    componentId?: PluginClientComponentId;
    requiredPermissions?: readonly PluginPermission[];
};

export interface PluginClientAdapterRegistration {
    pluginId: string;
    views: Readonly<Record<string, PluginClientViewAdapter>>;
}

export interface PluginClientRegistrationDisposable {
    dispose: () => void;
}

export interface ResolvedPluginClientView {
    pluginId: string;
    viewId: string;
    contribution: PluginViewContribution;
    surface: PluginViewSurface;
    path?: string;
    componentId?: PluginClientComponentId;
}

/**
 * Bundled UI adapters are the trust boundary for the first dynamic-host phase.
 * A server manifest may select these stable IDs, but cannot supply code, URLs,
 * routes, or component names of its own.
 */
const bundledPluginAdapters: readonly PluginClientAdapterRegistration[] = [{
    pluginId: 'relationship-advisor',
    views: {
        'relationship-advisor.chat': {
            surface: 'page',
            path: '/relationship-advisor',
            requiredPermissions: ['paws.ai.provider.invoke', 'paws.secrets.use'],
        },
        'relationship-advisor.history': {
            surface: 'left-sidebar',
            componentId: 'relationship-advisor-history',
        },
        'relationship-advisor.configuration': {
            surface: 'modal',
            componentId: 'plugin-configuration',
        },
    },
}, {
    pluginId: 'generated-images-gallery',
    views: {
        'generated-images-gallery.browser': {
            surface: 'page',
            path: '/generated-images',
            requiredPermissions: ['paws.conversations.images.read'],
        },
        'generated-images-gallery.session-images': {
            surface: 'right-panel',
            componentId: 'generated-images-session-images',
            requiredPermissions: ['paws.conversations.images.read'],
        },
    },
}];

function isCurrentInstallation(plugin: PluginCatalogItem): boolean {
    return plugin.status.installed && plugin.status.version === plugin.manifest.version;
}

export function createPluginClientHost(initialAdapters: readonly PluginClientAdapterRegistration[] = []) {
    const adapters = new Map<string, Readonly<Record<string, PluginClientViewAdapter>>>();

    function register(registration: PluginClientAdapterRegistration): PluginClientRegistrationDisposable {
        if (adapters.has(registration.pluginId)) {
            throw new Error(`Plugin client Adapter already registered: ${registration.pluginId}`);
        }
        adapters.set(registration.pluginId, registration.views);
        let disposed = false;
        return {
            dispose() {
                if (disposed) return;
                disposed = true;
                if (adapters.get(registration.pluginId) === registration.views) {
                    adapters.delete(registration.pluginId);
                }
            },
        };
    }

    function resolveView(
        plugin: PluginCatalogItem,
        viewId: string,
        surface: PluginViewSurface,
    ): ResolvedPluginClientView | null {
        if (!isCurrentInstallation(plugin)) return null;
        return resolveDeclaredView(plugin, viewId, surface);
    }

    function resolveDeclaredView(
        plugin: PluginCatalogItem,
        viewId: string,
        surface: PluginViewSurface,
    ): ResolvedPluginClientView | null {
        const contribution = plugin.manifest.contributes.views.find((view) => (
            view.id === viewId && view.surface === surface
        ));
        if (!contribution) return null;
        const adapter = adapters.get(plugin.manifest.id)?.[viewId];
        if (!adapter || adapter.surface !== surface) return null;
        if (adapter.requiredPermissions?.some((permission) => !plugin.manifest.permissions.includes(permission))) {
            return null;
        }
        return {
            pluginId: plugin.manifest.id,
            viewId,
            contribution,
            surface,
            path: adapter.path,
            componentId: adapter.componentId,
        };
    }

    function resolveEntrypoint(plugin: PluginCatalogItem): ResolvedPluginClientView | null {
        return resolveView(
            plugin,
            plugin.manifest.entrypoint.viewId,
            plugin.manifest.entrypoint.type === 'view' ? 'page' : 'modal',
        );
    }

    function resolveSurfaceViews(
        plugins: readonly PluginCatalogItem[],
        surface: PluginViewSurface,
    ): ResolvedPluginClientView[] {
        return plugins.flatMap((plugin) => plugin.manifest.contributes.views.flatMap((view) => {
            const resolved = resolveView(plugin, view.id, surface);
            return resolved ? [resolved] : [];
        }));
    }

    for (const adapter of initialAdapters) register(adapter);
    return { register, resolveDeclaredView, resolveEntrypoint, resolveSurfaceViews, resolveView };
}

const pluginClientHost = createPluginClientHost(bundledPluginAdapters);

export function registerPluginClientAdapter(
    registration: PluginClientAdapterRegistration,
): PluginClientRegistrationDisposable {
    return pluginClientHost.register(registration);
}

export function resolveInstalledPluginView(
    plugin: PluginCatalogItem,
    viewId: string,
    surface: PluginViewSurface,
): ResolvedPluginClientView | null {
    return pluginClientHost.resolveView(plugin, viewId, surface);
}

export function resolveInstalledPluginEntrypoint(
    plugin: PluginCatalogItem,
): ResolvedPluginClientView | null {
    return pluginClientHost.resolveEntrypoint(plugin);
}

export function resolveInstalledPluginSurfaceViews(
    plugins: readonly PluginCatalogItem[],
    surface: PluginViewSurface,
): ResolvedPluginClientView[] {
    return pluginClientHost.resolveSurfaceViews(plugins, surface);
}
