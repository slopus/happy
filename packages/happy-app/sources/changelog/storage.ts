import { MMKV } from 'react-native-mmkv';

const mmkv = new MMKV();

const LAST_VIEWED_KEY = 'changelog-last-viewed-title';

export function getLastViewedTitle(): string {
    return mmkv.getString(LAST_VIEWED_KEY) ?? '';
}

export function setLastViewedTitle(title: string): void {
    mmkv.set(LAST_VIEWED_KEY, title);
}

export function hasUnreadChangelog(latestTitle: string): boolean {
    return latestTitle !== '' && latestTitle !== getLastViewedTitle();
}
