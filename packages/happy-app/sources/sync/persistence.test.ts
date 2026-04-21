import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();

vi.mock('react-native-mmkv', () => ({
    MMKV: class {
        getString(key: string) {
            return store.get(key);
        }
        set(key: string, value: string) {
            store.set(key, value);
        }
        delete(key: string) {
            store.delete(key);
        }
        getNumber(key: string) {
            const value = store.get(key);
            return value === undefined ? undefined : Number(value);
        }
    }
}));

import {
    loadSessionEffortLevels,
    loadSessionModelModes,
    saveSessionEffortLevels,
    saveSessionModelModes,
} from './persistence';

describe('persistence session config maps', () => {
    beforeEach(() => {
        store.clear();
    });

    it('round-trips session model modes', () => {
        saveSessionModelModes({ s1: 'gpt-5.4' });

        expect(loadSessionModelModes()).toEqual({ s1: 'gpt-5.4' });
    });

    it('round-trips session effort levels', () => {
        saveSessionEffortLevels({ s1: 'medium' });

        expect(loadSessionEffortLevels()).toEqual({ s1: 'medium' });
    });
});
