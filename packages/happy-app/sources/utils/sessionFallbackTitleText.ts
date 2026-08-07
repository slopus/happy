export const SESSION_FALLBACK_TITLE_MAX_LENGTH = 80;

export function deriveSessionFallbackTitle(
    text: string,
    attachments?: { name: string }[],
): string | null {
    const source = text.trim() || attachments?.[0]?.name.trim() || '';
    const normalized = source
        .replace(/\s+/g, ' ')
        .replace(/^#{1,6}\s+/, '')
        .replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, '')
        .trim();
    if (!normalized) {
        return null;
    }
    return Array.from(normalized).slice(0, SESSION_FALLBACK_TITLE_MAX_LENGTH).join('').trim() || null;
}
