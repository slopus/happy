import type { PluginCatalogItem } from '@slopus/happy-wire';
import { describe, expect, it, vi } from 'vitest';

import { PluginCatalogStore } from './pluginCatalogStore';

function plugin(id: string): PluginCatalogItem {
    return {
        manifest: { id },
        status: { installed: false },
    } as PluginCatalogItem;
}

describe('PluginCatalogStore', () => {
    it('scopes configuration drafts to both the plugin version and the active account', () => {
        const store = new PluginCatalogStore();
        store.setConfigurationDraft('relationship-advisor', '1.0.0', {
            baseUrl: 'https://api.deepseek.com',
        });

        expect(store.getConfigurationDraft('relationship-advisor', '1.0.0')).toEqual({
            baseUrl: 'https://api.deepseek.com',
        });
        expect(store.getConfigurationDraft('relationship-advisor', '2.0.0')).toBeUndefined();

        store.beginAccount();

        expect(store.getConfigurationDraft('relationship-advisor', '1.0.0')).toBeUndefined();
    });

    it('only retires the submitted draft when no newer edit has replaced it', () => {
        const store = new PluginCatalogStore();
        const submitted = { baseUrl: 'https://api.deepseek.com' };
        store.setConfigurationDraft('relationship-advisor', '1.0.0', submitted);

        store.setConfigurationDraft('relationship-advisor', '1.0.0', {
            baseUrl: 'https://api.deepseek.com/v2',
        });
        store.clearConfigurationDraft('relationship-advisor', '1.0.0', submitted);
        expect(store.getConfigurationDraft('relationship-advisor', '1.0.0')).toEqual({
            baseUrl: 'https://api.deepseek.com/v2',
        });

        store.clearConfigurationDraft('relationship-advisor', '1.0.0', {
            baseUrl: 'https://api.deepseek.com/v2',
        });
        expect(store.getConfigurationDraft('relationship-advisor', '1.0.0')).toBeUndefined();
    });

    it('ignores draft operations that finish after the active account changes', () => {
        const store = new PluginCatalogStore();
        const priorAccount = store.getConfigurationDraftScope();
        store.setConfigurationDraft('relationship-advisor', '1.0.0', {
            baseUrl: 'https://account-a.example.com',
        }, priorAccount);

        store.beginAccount();
        const activeAccount = store.getConfigurationDraftScope();
        const activeDraft = { baseUrl: 'https://account-b.example.com' };
        store.setConfigurationDraft('relationship-advisor', '1.0.0', activeDraft, activeAccount);

        store.clearConfigurationDraft('relationship-advisor', '1.0.0', activeDraft, priorAccount);
        store.setConfigurationDraft('relationship-advisor', '1.0.0', {
            baseUrl: 'https://stale-account-a.example.com',
        }, priorAccount);

        expect(store.getConfigurationDraft('relationship-advisor', '1.0.0', priorAccount)).toBeUndefined();
        expect(store.getConfigurationDraft('relationship-advisor', '1.0.0', activeAccount)).toEqual(activeDraft);
    });

    it('clears the prior account catalog before loading a new account', () => {
        const store = new PluginCatalogStore();
        store.resolve([plugin('account-one-plugin')]);
        const listener = vi.fn();
        store.subscribe(listener);

        store.beginAccount();

        expect(store.getSnapshot()).toMatchObject({
            status: 'loading',
            plugins: [],
        });
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('retains the account catalog while refreshing and after a retryable failure', () => {
        const store = new PluginCatalogStore();
        const plugins = [plugin('server-plugin')];
        store.resolve(plugins);

        store.beginRefresh();
        expect(store.getSnapshot()).toMatchObject({ status: 'loading', plugins });

        store.reject();
        expect(store.getSnapshot()).toMatchObject({ status: 'error', plugins });
    });

    it('publishes immutable revisions for subscribers', () => {
        const store = new PluginCatalogStore();
        const initial = store.getSnapshot();
        store.resolve([plugin('server-plugin')]);
        const ready = store.getSnapshot();

        expect(initial).not.toBe(ready);
        expect(ready.status).toBe('ready');
        expect(ready.revision).toBe(initial.revision + 1);
    });

    it('ignores a catalog response that started before the active account changed', () => {
        const store = new PluginCatalogStore();
        const staleAccount = store.beginRefresh();

        store.beginAccount();
        store.resolve([plugin('stale-account-plugin')], staleAccount);

        expect(store.getSnapshot()).toMatchObject({
            status: 'loading',
            plugins: [],
        });

        const activeAccount = store.beginRefresh();
        store.resolve([plugin('active-account-plugin')], activeAccount);
        expect(store.getSnapshot()).toMatchObject({
            status: 'ready',
            plugins: [expect.objectContaining({ manifest: expect.objectContaining({ id: 'active-account-plugin' }) })],
        });
    });
});
