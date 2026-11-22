import { MMKV } from 'react-native-mmkv';
export { MMKV };
/** Native MMKV commits synchronously. Web overrides this completion boundary. */
export function flushDeviceStorageWrites(_store?: MMKV): Promise<void> { return Promise.resolve(); }
export function writeDeviceStorage(store: MMKV, key: string, value: string): Promise<void> {
    store.set(key, value); return flushDeviceStorageWrites(store);
}

export async function listDeviceStorageIds(_prefix: string, _suffix: string): Promise<string[]> { return []; }
export async function purgeAccountDeviceStorage(_scope: string): Promise<void> {}

export async function eraseDeviceStorageRecord(store: MMKV, key: string): Promise<void> { store.delete(key); }

export async function addDeviceStorageString(store: MMKV, key: string, value: string): Promise<void> {
    const previous = JSON.parse(store.getString(key) ?? '[]') as string[];
    store.set(key, JSON.stringify([...new Set([...previous, value])]));
}

export function markDeviceStorageDraftPending(_owner: object, _pending: boolean, _flush?: () => void): void {}
