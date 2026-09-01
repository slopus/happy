import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ResolvedAttachment, TranscriptCandidate } from './types';

const MIME_TYPES: Record<string, { mimeType: string; kind: ResolvedAttachment['kind'] }> = {
    '.aac': { mimeType: 'audio/aac', kind: 'audio' },
    '.flac': { mimeType: 'audio/flac', kind: 'audio' },
    '.gif': { mimeType: 'image/gif', kind: 'image' },
    '.jpeg': { mimeType: 'image/jpeg', kind: 'image' },
    '.jpg': { mimeType: 'image/jpeg', kind: 'image' },
    '.m4a': { mimeType: 'audio/mp4', kind: 'audio' },
    '.mov': { mimeType: 'video/quicktime', kind: 'video' },
    '.mp3': { mimeType: 'audio/mpeg', kind: 'audio' },
    '.mp4': { mimeType: 'video/mp4', kind: 'video' },
    '.ogg': { mimeType: 'audio/ogg', kind: 'audio' },
    '.png': { mimeType: 'image/png', kind: 'image' },
    '.svg': { mimeType: 'image/svg+xml', kind: 'image' },
    '.wav': { mimeType: 'audio/wav', kind: 'audio' },
    '.webm': { mimeType: 'video/webm', kind: 'video' },
    '.webp': { mimeType: 'image/webp', kind: 'image' },
};

export type JsonLine = Record<string, unknown>;

export async function readStableJsonLines(candidate: TranscriptCandidate): Promise<JsonLine[]> {
    const before = await stat(candidate.path);
    const raw = await readFile(candidate.path, 'utf8');
    const after = await stat(candidate.path);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw new Error('Session changed while it was being read; retry after the current turn finishes');
    }
    return raw.split(/\r?\n/).filter(Boolean).map((line, index) => {
        try {
            const value = JSON.parse(line) as unknown;
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
            return value as JsonLine;
        } catch (error) {
            throw new Error(`Invalid JSONL at line ${index + 1}: ${(error as Error).message}`);
        }
    });
}

function isWithin(root: string, file: string): boolean {
    const child = relative(root, file);
    return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child));
}

function uuidFromSessionAttachment(session: string, file: string): string {
    const bytes = createHash('sha256').update(session).update('\0').update(file).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function resolveStructuredAttachment(
    candidate: TranscriptCandidate,
    reference: string,
    recordedCwd?: string,
): Promise<ResolvedAttachment> {
    const sessionDirectory = dirname(candidate.path);
    const cwd = recordedCwd
        ? (isAbsolute(recordedCwd) ? resolve(recordedCwd) : resolve(sessionDirectory, recordedCwd))
        : sessionDirectory;
    const normalizedReference = reference.startsWith('file://') ? decodeURIComponent(new URL(reference).pathname) : reference;
    const file = resolve(isAbsolute(normalizedReference) ? normalizedReference : resolve(cwd, normalizedReference));
    if (!isWithin(cwd, file) && !isWithin(sessionDirectory, file)) {
        throw new Error(`Attachment is outside the session root: ${basename(file)}`);
    }
    const metadata = await stat(file);
    if (!metadata.isFile()) throw new Error(`Attachment is not a regular file: ${basename(file)}`);
    const bytes = await readFile(file);
    const media = MIME_TYPES[extname(file).toLowerCase()] ?? { mimeType: 'application/octet-stream', kind: 'file' as const };
    return {
        attachmentId: uuidFromSessionAttachment(resolve(candidate.path), file),
        path: file,
        name: basename(file),
        mimeType: media.mimeType,
        kind: media.kind,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
    };
}

export function timestamp(value: unknown, fallback: number): number {
    if (typeof value !== 'string') return fallback;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

export function publicTitle(value: string | undefined): string {
    const normalized = value?.replace(/\s+/g, ' ').trim();
    return normalized ? normalized.slice(0, 120) : 'Shared coding session';
}

export function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function recordValue(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
