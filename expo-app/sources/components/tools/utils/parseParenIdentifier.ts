export type ParsedParenIdentifier = { name: string; spec: string };

export function parseParenIdentifier(value: string): ParsedParenIdentifier | null {
    const match = value.match(/^([^(]+)\((.+)\)$/);
    if (!match) return null;
    return { name: match[1], spec: match[2] };
}

