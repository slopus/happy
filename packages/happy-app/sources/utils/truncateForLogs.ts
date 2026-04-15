const DEFAULT_MAX_STRING_LENGTH = 500;
const MAX_DEPTH = 10;

function truncateString(value: string, maxLength: number): string {
    if (value.length <= maxLength) return value;
    const prefixLen = Math.ceil(maxLength * 0.4);
    const suffixLen = Math.floor(maxLength * 0.3);
    return value.slice(0, prefixLen) + ' [... TRUNCATED FOR LOGS] ' + value.slice(-suffixLen);
}

export function truncateForLogs(value: unknown, maxStringLength = DEFAULT_MAX_STRING_LENGTH, _depth = 0): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return truncateString(value, maxStringLength);
    if (typeof value !== 'object') return value;
    if (_depth >= MAX_DEPTH) return '[...]';

    if (Array.isArray(value)) {
        return value.map(item => truncateForLogs(item, maxStringLength, _depth + 1));
    }

    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        result[key] = truncateForLogs(val, maxStringLength, _depth + 1);
    }
    return result;
}

export function serializeForLogs(value: unknown, maxStringLength = DEFAULT_MAX_STRING_LENGTH): string {
    if (typeof value === 'string') return truncateString(value, maxStringLength);

    const truncated = truncateForLogs(value, maxStringLength);
    try {
        return JSON.stringify(truncated, null, 2) ?? String(truncated);
    } catch {
        return String(truncated);
    }
}
