export interface ChangelogEntry {
    version: number;
    date: string;
    summary: string;
    changes: string[];
    rawMarkdown?: string;
}

export interface ChangelogData {
    entries: ChangelogEntry[];
    latestVersion: number;
}