import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ account: 'A', stores: new Map<string, Map<string, string | boolean>>() }));
vi.mock('@/auth/accountRuntime', () => ({ accountStorageId: (base: string) => `${base}-${state.account}` }));
vi.mock('react-native-mmkv', () => ({ MMKV: class {
    store: Map<string, string | boolean>;
    constructor({ id }: { id: string }) { if (!state.stores.has(id)) state.stores.set(id, new Map()); this.store = state.stores.get(id)!; }
    getString(key: string) { const value = this.store.get(key); return typeof value === 'string' ? value : undefined; }
    getBoolean(key: string) { const value = this.store.get(key); return typeof value === 'boolean' ? value : undefined; }
    set(key: string, value: string | boolean) { this.store.set(key, value); }
    delete(key: string) { this.store.delete(key); }
} }));
beforeEach(() => { vi.resetModules(); state.account = 'A'; state.stores.clear(); });
it('restores A draft after A → B → A and clears only the active draft', async () => {
    let draft = await import('./composeDraft');
    draft.useComposeDraft.getState().setText('private A draft');
    state.account = 'B'; vi.resetModules(); draft = await import('./composeDraft');
    expect(draft.useComposeDraft.getState().text).toBe('');
    draft.useComposeDraft.getState().setText('B draft');
    draft.clearComposeDraft();
    state.account = 'A'; vi.resetModules(); draft = await import('./composeDraft');
    expect(draft.useComposeDraft.getState().text).toBe('private A draft');
});
