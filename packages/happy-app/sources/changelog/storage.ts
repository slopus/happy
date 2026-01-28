import { MMKV } from 'react-native-mmkv';

const mmkv = new MMKV();

const LAST_VIEWED_VERSION_KEY = 'changelog-last-viewed-version';

export function getLastViewedVersion(): number {
    return mmkv.getNumber(LAST_VIEWED_VERSION_KEY) ?? 0;
}

export function setLastViewedVersion(version: number): void {
    mmkv.set(LAST_VIEWED_VERSION_KEY, version);
}

export function hasUnreadChangelog(latestVersion: number): boolean {
    const lastViewed = getLastViewedVersion();
    return latestVersion > lastViewed;
}