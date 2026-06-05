export interface ChangelogEntry {
    title: string;
    summary: string;
    markdown: string;
}

export interface ChangelogData {
    entries: ChangelogEntry[];
    latestTitle: string;
}
