import { ChangelogData, ChangelogEntry } from './types';

let changelogData: ChangelogData | null = null;

export function getChangelogData(): ChangelogData {
    if (!changelogData) {
        try {
            changelogData = require('./changelog.json') as ChangelogData;
        } catch (error) {
            console.warn('Changelog data not found, returning empty changelog');
            changelogData = { entries: [], latestTitle: '' };
        }
    }
    return changelogData;
}

export function getChangelogEntries(): ChangelogEntry[] {
    return getChangelogData().entries;
}

export function getLatestTitle(): string {
    return getChangelogData().latestTitle;
}
