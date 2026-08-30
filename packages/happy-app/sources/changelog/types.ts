export interface ChangelogEntry {
    title: string;
    summary: string;
    markdown: string;
    /** Bundled image rendered at the end of the title, keyed by path relative to sources/changelog/ */
    titleImage?: string;
}

export interface ChangelogData {
    entries: ChangelogEntry[];
    latestTitle: string;
}
