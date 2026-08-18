import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();

vi.mock('react-native-mmkv', () => ({
    MMKV: class {
        getString(key: string) { return store.get(key); }
        getNumber(key: string) {
            const value = store.get(key);
            return value === undefined ? undefined : Number(value);
        }
        set(key: string, value: string | number) { store.set(key, String(value)); }
        delete(key: string) { store.delete(key); }
        clearAll() { store.clear(); }
    },
}));

const { loadPendingSettings, savePendingSettings } = await import('./persistence');

describe('loadPendingSettings', () => {
    beforeEach(() => store.clear());

    it('returns an empty queue without injecting schema defaults', () => {
        savePendingSettings({});

        expect(loadPendingSettings()).toEqual({});
    });

    it('keeps only settings that were actually queued', () => {
        savePendingSettings({ viewInline: true });

        expect(loadPendingSettings()).toEqual({ viewInline: true });
    });

    it('preserves a queued agent default override', () => {
        savePendingSettings({
            agentDefaultOverrides: {
                claude: { modelMode: 'claude-opus-5' },
                codex: { effortLevel: 'xhigh' },
            },
        });

        expect(loadPendingSettings()).toEqual({
            agentDefaultOverrides: {
                claude: { modelMode: 'claude-opus-5' },
                codex: { effortLevel: 'xhigh' },
            },
        });
    });

    it('preserves a deliberate reset of agent defaults', () => {
        savePendingSettings({ agentDefaultOverrides: {} });

        expect(loadPendingSettings()).toEqual({ agentDefaultOverrides: {} });
    });

    it('preserves another explicitly queued default-backed setting', () => {
        store.set('pending-settings', JSON.stringify({ dismissedCLIWarnings: {} }));

        expect(loadPendingSettings()).toEqual({
            dismissedCLIWarnings: { perMachine: {}, global: {} },
        });
    });

    it('falls back to an empty queue for malformed or non-object data', () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        store.set('pending-settings', '{not json');
        expect(loadPendingSettings()).toEqual({});
        expect(errorSpy).toHaveBeenCalledOnce();
        errorSpy.mockRestore();

        store.set('pending-settings', JSON.stringify(['viewInline']));
        expect(loadPendingSettings()).toEqual({});

        store.set('pending-settings', JSON.stringify('viewInline'));
        expect(loadPendingSettings()).toEqual({});
    });
});
