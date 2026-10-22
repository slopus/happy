export type SessionLink = { sessionId: string; title: string };
export function parseSessionLink(content: string): SessionLink | null {
    try {
        const value = JSON.parse(content);
        if (typeof value.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.sessionId)
            || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 200) return null;
        return { sessionId: value.sessionId, title: value.title.trim() };
    } catch { return null; }
}
