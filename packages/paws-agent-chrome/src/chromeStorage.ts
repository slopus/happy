import type { KeyValueStorage } from '@wangjs-jacky/paws-agent/browser';

export function createChromeStorage(): KeyValueStorage {
    return {
        async get(key) {
            const value = (await chrome.storage.local.get(key))[key];
            return typeof value === 'string' ? value : null;
        },
        async set(key, value) {
            await chrome.storage.local.set({ [key]: value });
        },
        async remove(key) {
            await chrome.storage.local.remove(key);
        },
    };
}
