export function maybeParseJson(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (!trimmed) return value;
    const first = trimmed[0];
    if (first !== '{' && first !== '[') return value;
    try {
        return JSON.parse(trimmed) as unknown;
    } catch {
        return value;
    }
}

