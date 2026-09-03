import type { PluginCatalogItem, PluginInstallationStatus } from '@slopus/happy-wire';

export type PluginCatalogStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface PluginCatalogSnapshot {
    status: PluginCatalogStatus;
    plugins: readonly PluginCatalogItem[];
    revision: number;
}

const EMPTY_PLUGIN_CATALOG: readonly PluginCatalogItem[] = [];

type PluginCatalogRefresh = {
    accountGeneration: number;
    mutationRevision: number;
};

function configurationDraftKey(pluginId: string, pluginVersion: string): string {
    return JSON.stringify([pluginId, pluginVersion]);
}

function equalConfigurationDrafts(
    left: Record<string, string> | undefined,
    right: Record<string, string>,
): boolean {
    if (!left) return Object.keys(right).length === 0;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
        && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

export class PluginCatalogStore {
    private snapshot: PluginCatalogSnapshot = {
        status: 'idle',
        plugins: EMPTY_PLUGIN_CATALOG,
        revision: 0,
    };
    private readonly listeners = new Set<() => void>();
    private readonly configurationDrafts = new Map<string, Record<string, string>>();
    private readonly installationStatusOverrides = new Map<string, {
        revision: number;
        status: PluginInstallationStatus;
    }>();
    private accountGeneration = 0;
    private mutationRevision = 0;

    getSnapshot = (): PluginCatalogSnapshot => this.snapshot;

    getConfigurationDraftScope(): number {
        return this.accountGeneration;
    }

    isConfigurationDraftScopeCurrent(scope: number): boolean {
        return scope === this.accountGeneration;
    }

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    beginAccount(): void {
        this.accountGeneration += 1;
        this.mutationRevision = 0;
        this.configurationDrafts.clear();
        this.installationStatusOverrides.clear();
        this.publish('loading', EMPTY_PLUGIN_CATALOG);
    }

    getConfigurationDraft(
        pluginId: string,
        pluginVersion: string,
        scope = this.accountGeneration,
    ): Record<string, string> | undefined {
        if (!this.isConfigurationDraftScopeCurrent(scope)) return undefined;
        const draft = this.configurationDrafts.get(configurationDraftKey(pluginId, pluginVersion));
        return draft ? { ...draft } : undefined;
    }

    setConfigurationDraft(
        pluginId: string,
        pluginVersion: string,
        draft: Record<string, string>,
        scope = this.accountGeneration,
    ): void {
        if (!this.isConfigurationDraftScopeCurrent(scope)) return;
        const key = configurationDraftKey(pluginId, pluginVersion);
        if (Object.keys(draft).length === 0) {
            this.configurationDrafts.delete(key);
            return;
        }
        this.configurationDrafts.set(key, { ...draft });
    }

    clearConfigurationDraft(
        pluginId: string,
        pluginVersion: string,
        expectedDraft?: Record<string, string>,
        scope = this.accountGeneration,
    ): void {
        if (!this.isConfigurationDraftScopeCurrent(scope)) return;
        const key = configurationDraftKey(pluginId, pluginVersion);
        if (expectedDraft && !equalConfigurationDrafts(this.configurationDrafts.get(key), expectedDraft)) return;
        this.configurationDrafts.delete(key);
    }

    beginRefresh(): PluginCatalogRefresh {
        const refresh = {
            accountGeneration: this.accountGeneration,
            mutationRevision: this.mutationRevision,
        };
        this.publish('loading', this.snapshot.plugins);
        return refresh;
    }

    resolve(
        plugins: readonly PluginCatalogItem[],
        refresh: PluginCatalogRefresh = {
            accountGeneration: this.accountGeneration,
            mutationRevision: this.mutationRevision,
        },
    ): void {
        if (refresh.accountGeneration !== this.accountGeneration) return;
        const resolved = plugins.map((plugin) => {
            const override = this.installationStatusOverrides.get(plugin.manifest.id);
            if (!override) return plugin;
            if (override.revision <= refresh.mutationRevision) {
                this.installationStatusOverrides.delete(plugin.manifest.id);
                return plugin;
            }
            return { ...plugin, status: override.status };
        });
        this.publish('ready', resolved);
    }

    reject(refresh: PluginCatalogRefresh = {
        accountGeneration: this.accountGeneration,
        mutationRevision: this.mutationRevision,
    }): void {
        if (refresh.accountGeneration !== this.accountGeneration) return;
        this.publish('error', this.snapshot.plugins);
    }

    setPluginInstallationStatus(
        pluginId: string,
        status: PluginInstallationStatus,
        scope = this.accountGeneration,
    ): void {
        if (scope !== this.accountGeneration) return;
        const item = this.snapshot.plugins.find((plugin) => plugin.manifest.id === pluginId);
        if (!item) return;
        this.mutationRevision += 1;
        this.installationStatusOverrides.set(pluginId, {
            revision: this.mutationRevision,
            status,
        });
        this.publish(this.snapshot.status, this.snapshot.plugins.map((plugin) => (
            plugin.manifest.id === pluginId ? { ...plugin, status } : plugin
        )));
    }

    private publish(status: PluginCatalogStatus, plugins: readonly PluginCatalogItem[]): void {
        this.snapshot = {
            status,
            plugins,
            revision: this.snapshot.revision + 1,
        };
        for (const listener of this.listeners) listener();
    }
}
