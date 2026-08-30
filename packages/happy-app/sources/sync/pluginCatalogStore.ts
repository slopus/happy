import type { PluginCatalogItem } from '@slopus/happy-wire';

export type PluginCatalogStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface PluginCatalogSnapshot {
    status: PluginCatalogStatus;
    plugins: readonly PluginCatalogItem[];
    revision: number;
}

const EMPTY_PLUGIN_CATALOG: readonly PluginCatalogItem[] = [];

export class PluginCatalogStore {
    private snapshot: PluginCatalogSnapshot = {
        status: 'idle',
        plugins: EMPTY_PLUGIN_CATALOG,
        revision: 0,
    };
    private readonly listeners = new Set<() => void>();
    private accountGeneration = 0;

    getSnapshot = (): PluginCatalogSnapshot => this.snapshot;

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    beginAccount(): void {
        this.accountGeneration += 1;
        this.publish('loading', EMPTY_PLUGIN_CATALOG);
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
