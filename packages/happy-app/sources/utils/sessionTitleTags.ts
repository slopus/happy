export type SessionTitleTagQuery = {
    query: string;
    start: number;
};

export function findSessionTitleTagQuery(value: string): SessionTitleTagQuery | null {
    const match = /(^|\s)#([^#\s]*)$/.exec(value);
    if (!match) return null;
    return {
        query: match[2] ?? '',
        start: match.index + match[1].length,
    };
}

export function removeSessionTitleTagQuery(value: string, start: number): string {
    return value.slice(0, start).trimEnd();
}
