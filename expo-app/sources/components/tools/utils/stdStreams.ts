import { maybeParseJson } from './parseJson';

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

export type StdStreams = { stdout?: string; stderr?: string };

export function extractStdStreams(result: unknown): StdStreams | null {
    const parsed = maybeParseJson(result);
    const obj = asRecord(parsed);
    if (!obj) return null;

    const stdout = typeof obj.stdout === 'string' ? obj.stdout : undefined;
    const stderr = typeof obj.stderr === 'string' ? obj.stderr : undefined;
    if (!stdout && !stderr) return null;

    return { stdout, stderr };
}

export function tailTextWithEllipsis(text: string, maxChars: number): string {
    if (maxChars <= 0) return '';
    if (text.length <= maxChars) return text;
    return `…${text.slice(-maxChars)}`;
}

