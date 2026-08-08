/**
 * Local-file attachment lane helpers.
 *
 * Unlike images (E2E-encrypted, decrypted into memory, sniffed by magic byte),
 * Audio/video may travel plaintext and stream straight to disk; PDF files stay
 * encrypted and are staged after decryption. The model receives each exact
 * local path as text. These helpers decide the kind, pick a safe filename, and
 * format the prompt notice.
 */
import { chmod, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { configuration } from '@/configuration';
import type { MediaAttachment } from '@/utils/MessageQueue2';

const stagedMediaPaths = new Set<string>();

function isMissingFileError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function removeStagedMediaPath(localPath: string): Promise<void> {
    try {
        await unlink(localPath);
        stagedMediaPaths.delete(localPath);
    } catch (error) {
        if (isMissingFileError(error)) stagedMediaPaths.delete(localPath);
        // Keep other failures registered so session shutdown can retry them.
    }
}

/** File-event fields this module needs — a structural subset of the wire schema. */
export type MediaFileEvent = {
    ref: string;
    name: string;
    size: number;
    mimeType?: string;
    kind?: 'image' | 'audio' | 'video' | 'file';
    encrypted?: boolean;
};

/**
 * Whether a file event takes the plaintext streaming lane. Only explicit
 * `encrypted: false` opts in; anything missing/true stays on the encrypted
 * image path (back-compat with historical image-only events).
 */
export function isPlaintextMediaEvent(ev: MediaFileEvent): boolean {
    return ev.encrypted === false;
}

/**
 * Resolve the media kind. Trust the wire `kind` first; otherwise fall back to
 * the mimeType prefix, then the filename extension. Defaults to 'video' when
 * nothing is conclusive (it still lands on disk and the path is handed off).
 */
export function resolveMediaKind(ev: MediaFileEvent): 'audio' | 'video' | 'file' {
    if (ev.kind === 'audio' || ev.kind === 'video' || ev.kind === 'file') return ev.kind;
    const mime = (ev.mimeType ?? '').toLowerCase();
    if (mime.startsWith('audio/')) return 'audio';
    if (mime.startsWith('video/')) return 'video';
    if (mime === 'application/pdf') return 'file';
    const ext = (ev.name.match(/\.([^.]+)$/)?.[1] ?? '').toLowerCase();
    if (['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'].includes(ext)) return 'audio';
    if (ext === 'pdf') return 'file';
    return 'video';
}

/**
 * Absolute staging path under the attachments dir, keeping the original
 * extension and sanitising the base name. A ref-derived key prevents files
 * received in the same millisecond from colliding; tests use a fixed stamp.
 */
export function stagedMediaPath(ev: MediaFileEvent, stamp: string, index: number): string {
    const ext = ev.name.match(/\.([^.]+)$/)?.[1]?.replace(/[^\w]+/g, '') ?? '';
    const base = ev.name.replace(/\.[^.]+$/, '').replace(/[^\w.\-]+/g, '_') || 'media';
    const safeStamp = stamp.replace(/[:.]/g, '-');
    const refKey = createHash('sha256').update(ev.ref).digest('hex').slice(0, 12);
    const fileName = ext
        ? `${safeStamp}-${index}-${refKey}-${base}.${ext}`
        : `${safeStamp}-${index}-${refKey}-${base}`;
    return join(configuration.attachmentsDir, fileName);
}

/** Restrict a streamed attachment to the current user and track it for cleanup. */
export async function secureAndRegisterStagedMediaPath(localPath: string): Promise<void> {
    stagedMediaPaths.add(localPath);
    try {
        await chmod(localPath, 0o600);
    } catch (error) {
        await removeStagedMediaPath(localPath);
        throw error;
    }
}

/** Remove plaintext files after the model turn that consumed them finishes. */
export async function cleanupMediaAttachments(items: readonly MediaAttachment[]): Promise<void> {
    await Promise.all(items.map(async (item) => {
        await removeStagedMediaPath(item.localPath);
    }));
}

/** Best-effort session/process cleanup for queued or interrupted attachments. */
export async function cleanupAllStagedMediaAttachments(): Promise<void> {
    const paths = [...stagedMediaPaths];
    await Promise.all(paths.map(async (localPath) => {
        await removeStagedMediaPath(localPath);
    }));
}

/**
 * Persist already-decrypted media bytes to the attachments dir and build the
 * MediaAttachment. Used for the encrypted media lane (audio/video that travelled
 * the same E2E path as images): the CLI decrypts into memory, writes to disk,
 * and hands the model the local path. The resulting file is mode 0600 and is
 * registered for cleanup after the consuming model turn.
 */
export async function buildMediaAttachmentFromBytes(
    ev: MediaFileEvent,
    bytes: Uint8Array,
    stamp: string,
    index: number,
): Promise<MediaAttachment> {
    const kind = resolveMediaKind(ev);
    const destPath = stagedMediaPath(ev, stamp, index);
    await writeFile(destPath, bytes, { mode: 0o600 });
    stagedMediaPaths.add(destPath);
    return {
        kind,
        localPath: destPath,
        size: bytes.length,
        mimeType: ev.mimeType ?? 'application/octet-stream',
        name: ev.name,
    };
}

/** Whether a file event should be staged to a local path instead of sent as an image. */
export function isMediaFileEvent(ev: MediaFileEvent): boolean {
    if (ev.kind === 'audio' || ev.kind === 'video' || ev.kind === 'file') return true;
    const mime = (ev.mimeType ?? '').toLowerCase();
    if (mime.startsWith('audio/') || mime.startsWith('video/') || mime === 'application/pdf') return true;
    return ev.name.toLowerCase().endsWith('.pdf');
}

function humanSize(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${bytes}B`;
}

/**
 * Prompt text injected for staged local-file attachments. Returns null when
 * there are none. PDFs are directly readable at their path; audio/video can be
 * processed with command-line tools.
 */
export function formatMediaAttachmentNotice(items: MediaAttachment[]): string | null {
    if (items.length === 0) return null;
    const lines = items.map((it, i) => {
        const label = it.kind === 'audio' ? 'Audio' : it.kind === 'video' ? 'Video' : 'File';
        return `- ${label} ${i + 1}: ${it.localPath} (${it.mimeType}, ${humanSize(it.size)})`;
    });
    const hasDocument = items.some((item) => item.kind === 'file');
    const hasMedia = items.some((item) => item.kind === 'audio' || item.kind === 'video');
    return [
        `Happy attached ${items.length} user-uploaded local file${items.length === 1 ? '' : 's'} to this turn:`,
        ...lines,
        ...(hasDocument ? ['Use the exact local file path above to read or process the PDF according to the user request.'] : []),
        ...(hasMedia ? ['Audio/video content is available at the exact paths above; use command-line tools such as ffmpeg or whisper when needed.'] : []),
        'Do not scan ~/.happy/attachments or guess which file the user intended.',
    ].join('\n');
}
