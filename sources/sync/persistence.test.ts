import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();

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

import { clearPersistence, loadSessionModelModes, saveSessionModelModes } from './persistence';

describe('persistence', () => {
    beforeEach(() => {
        clearPersistence();
    });

    describe('session model modes', () => {
        it('returns an empty object when nothing is persisted', () => {
            expect(loadSessionModelModes()).toEqual({});
        });

        it('roundtrips session model modes', () => {
            saveSessionModelModes({ abc: 'gemini-2.5-pro' });
            expect(loadSessionModelModes()).toEqual({ abc: 'gemini-2.5-pro' });
        });

        it('filters out invalid persisted model modes', () => {
            store.set(
                'session-model-modes',
                JSON.stringify({ abc: 'gemini-2.5-pro', bad: 'adaptiveUsage' }),
            );
            expect(loadSessionModelModes()).toEqual({ abc: 'gemini-2.5-pro' });
        });
    });
});
