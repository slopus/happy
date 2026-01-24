import { beforeEach, vi } from 'vitest';

// Vitest runs in Node; `react-native-mmkv` depends on React Native internals and can fail to parse.
// Provide a minimal in-memory implementation for tests.
const store = new Map<string, string>();

beforeEach(() => {
    store.clear();
});

vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return store.get(key);
        }

        set(key: string, value: string) {
            store.set(key, value);
        }

        delete(key: string) {
            store.delete(key);
        }

        clearAll() {
            store.clear();
        }
    }

    return { MMKV };
});

