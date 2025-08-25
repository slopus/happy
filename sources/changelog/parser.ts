import { ChangelogData, ChangelogEntry } from './types';

// This will be populated by the build-time script
let changelogData: ChangelogData | null = null;

export function getChangelogData(): ChangelogData {
    if (!changelogData) {
        // Fallback to require the generated JSON file
        try {
            changelogData = require('./changelog.json') as ChangelogData;
        } catch (error) {
            console.warn('Changelog data not found, returning empty changelog');
            changelogData = { entries: [], latestVersion: 0 };
        }
    }
    return changelogData;
}

export function getChangelogEntries(): ChangelogEntry[] {
    return getChangelogData().entries;
}

export function getLatestVersion(): number {
    return getChangelogData().latestVersion;
}

export function getUnreadEntries(lastViewedVersion: number): ChangelogEntry[] {
    return getChangelogData().entries.filter(entry => entry.version > lastViewedVersion);
}