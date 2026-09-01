import type { PluginCatalogItem } from '@slopus/happy-wire';

export type PluginCatalogStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface PluginCatalogSnapshot {
    status: PluginCatalogStatus;
    plugins: readonly PluginCatalogItem[];
    revision: number;
}

const EMPTY_PLUGIN_CATALOG: readonly PluginCatalogItem[] = [];

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
    private accountGeneration = 0;

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
        this.configurationDrafts.clear();
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

    beginRefresh(): number {
        const generation = this.accountGeneration;
        this.publish('loading', this.snapshot.plugins);
        return generation;
    }

    resolve(plugins: readonly PluginCatalogItem[], generation = this.accountGeneration): void {
        if (generation !== this.accountGeneration) return;
        this.publish('ready', [...plugins]);
    }

    reject(generation = this.accountGeneration): void {
        if (generation !== this.accountGeneration) return;
        this.publish('error', this.snapshot.plugins);
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
