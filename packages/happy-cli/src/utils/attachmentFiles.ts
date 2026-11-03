/**
 * Attachments the app sends (pictures from the composer) reach the agent as
 * files on this machine, named by path in the prompt, instead of being pushed
 * into the model's context as image blocks. The agent opens one only when it
 * needs to see it (Claude's Read, Codex's view_image), so a large or
 * irrelevant picture costs nothing, and a session never breaks on an image
 * the provider refuses.
 *
 * The bytes are written next to the agent — the CLI that downloaded them is
 * the one running it — so the path is valid even when the phone and the
 * agent are on different machines.
 */
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import type { PendingAttachment } from '@/utils/MessageQueue2';

export type SupportedImageType = {
    mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
    extension: 'png' | 'jpg' | 'gif' | 'webp';
};

export type SavedAttachment = {
    path: string;
    /** Detected from the bytes for the four formats models read, else what the sender claimed. */
    mimeType: string;
    size: number;
    isImage: boolean;
};

/** Session folders untouched for this long are removed at the next start. */
export const ATTACHMENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const NOTE_HEADER_PREFIX = 'The user attached ';

export function detectSupportedImageType(data: Uint8Array): SupportedImageType | null {
    if (
        data.length >= 8
        && data[0] === 0x89
        && data[1] === 0x50
        && data[2] === 0x4e
        && data[3] === 0x47
        && data[4] === 0x0d
        && data[5] === 0x0a
        && data[6] === 0x1a
        && data[7] === 0x0a
    ) {
        return { mimeType: 'image/png', extension: 'png' };
    }

    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
        return { mimeType: 'image/jpeg', extension: 'jpg' };
    }

    if (data.length >= 6) {
        const header = new TextDecoder().decode(data.slice(0, 6));
        if (header === 'GIF87a' || header === 'GIF89a') {
            return { mimeType: 'image/gif', extension: 'gif' };
        }
    }

    if (
        data.length >= 12
        && data[0] === 0x52
        && data[1] === 0x49
        && data[2] === 0x46
        && data[3] === 0x46
        && data[8] === 0x57
        && data[9] === 0x45
        && data[10] === 0x42
        && data[11] === 0x50
    ) {
        return { mimeType: 'image/webp', extension: 'webp' };
    }

    return null;
}

export function resolveAttachmentsRootDir(rootDir?: string): string {
    return resolve(rootDir ?? join(configuration.happyHomeDir, 'attachments'));
}

/** The folder one Happy session's attachments are written to, always inside the root. */
export function resolveAttachmentDir(opts: { sessionId: string; rootDir?: string }): string {
    const root = resolveAttachmentsRootDir(opts.rootDir);
    const dir = resolve(root, sanitizePathSegment(opts.sessionId, 'unknown-session'));
    const relativePath = relative(root, dir);
    if (relativePath.length === 0 || relativePath.startsWith('..') || isAbsolute(relativePath)) {
        return join(root, 'invalid-session');
    }
    return dir;
}

export async function ensureAttachmentDir(opts: { sessionId: string; rootDir?: string }): Promise<string> {
    const dir = resolveAttachmentDir(opts);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    return dir;
}

function sanitizePathSegment(value: string, fallback: string): string {
    const sanitized = value
        .trim()
        .replace(/[\\/]+/g, '_')
        .replace(/\.+/g, '_')
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80);
    return sanitized.length > 0 ? sanitized : fallback;
}

/**
 * A fresh name that says nothing about the original: picker names can be
 * presigned URLs or data URIs, and none of that belongs in a path the
 * transcript keeps.
 */
function fileNameFor(attachment: PendingAttachment, detected: SupportedImageType | null): string {
    const subtype = /^[a-z]+\/([a-z0-9]{1,8})$/.exec(attachment.mimeType.toLowerCase())?.[1];
    return `${randomUUID()}.${detected?.extension ?? subtype ?? 'bin'}`;
}

/**
 * Writes each attachment into the session's folder and returns the ones that
 * were written, in order. A failed write is logged and left out.
 */
export async function saveAttachmentFiles(
    attachments: PendingAttachment[] | undefined,
    opts: { sessionId: string; rootDir?: string },
): Promise<SavedAttachment[]> {
    if (!attachments || attachments.length === 0) {
        return [];
    }

    const saved: SavedAttachment[] = [];
    let dir: string;
    try {
        dir = await ensureAttachmentDir(opts);
    } catch (error) {
        logger.debug('[attachments] Could not create the attachment folder', {
            errorName: error instanceof Error ? error.name : typeof error,
        });
        return [];
    }

    for (const attachment of attachments) {
        const detected = detectSupportedImageType(attachment.data);
        const path = join(dir, fileNameFor(attachment, detected));
        try {
            await writeFile(path, Buffer.from(attachment.data), { mode: 0o600, flag: 'wx' });
            saved.push({
                path,
                mimeType: detected?.mimeType ?? attachment.mimeType,
                size: attachment.data.length,
                isImage: detected !== null || attachment.mimeType.startsWith('image/'),
            });
        } catch (error) {
            logger.debug('[attachments] Failed to write attachment', {
                mimeType: attachment.mimeType,
                size: attachment.data.length,
                errorName: error instanceof Error ? error.name : typeof error,
            });
        }
    }
    return saved;
}

/** What the agent reads alongside the message: where each attachment is, and that it is not loaded. */
export function formatAttachmentNote(files: SavedAttachment[]): string | null {
    if (files.length === 0) {
        return null;
    }
    const allImages = files.every((file) => file.isImage);
    const noun = allImages ? 'image' : 'file';
    const count = files.length === 1 ? `1 ${noun}` : `${files.length} ${noun}s`;
    const pronoun = files.length === 1 ? 'It was' : 'They were';
    const lines = [
        `${NOTE_HEADER_PREFIX}${count}. ${pronoun} saved on this machine and not loaded into your context; open ${files.length === 1 ? 'it' : 'them'} with your file-reading or image-viewing tool only if you need to see ${files.length === 1 ? 'it' : 'them'}:`,
        ...files.map((file) => `- ${file.path}`),
    ];
    return lines.join('\n');
}

/** The paths an attachment note names, so a rebuilt transcript can show the pictures again. */
export function parseAttachmentNotePaths(text: string): string[] {
    const paths: string[] = [];
    let inNote = false;
    for (const line of text.split('\n')) {
        if (line.startsWith(NOTE_HEADER_PREFIX)) {
            inNote = true;
            continue;
        }
        if (!inNote) continue;
        if (line.startsWith('- ') && isAbsolute(line.slice(2).trim())) {
            paths.push(line.slice(2).trim());
            continue;
        }
        inNote = false;
    }
    return paths;
}

/**
 * Removes session folders under each root that nothing was written to for
 * `maxAgeMs`, except the running session's. A transcript that still names
 * one of those files finds it gone; the agent says so instead of guessing.
 */
export async function pruneAttachmentDirs(opts: {
    keepSessionId?: string;
    rootDirs?: string[];
    maxAgeMs?: number;
    now?: number;
} = {}): Promise<void> {
    const roots = opts.rootDirs ?? [resolveAttachmentsRootDir()];
    const cutoff = (opts.now ?? Date.now()) - (opts.maxAgeMs ?? ATTACHMENT_RETENTION_MS);
    const keep = opts.keepSessionId ? sanitizePathSegment(opts.keepSessionId, 'unknown-session') : null;

    for (const root of roots) {
        let entries: string[];
        try {
            entries = await readdir(root);
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (entry === keep) continue;
            const dir = join(root, entry);
            try {
                const info = await stat(dir);
                if (!info.isDirectory() || info.mtimeMs >= cutoff) continue;
                await rm(dir, { recursive: true, force: true });
            } catch (error) {
                logger.debug('[attachments] Failed to prune attachment folder', {
                    errorName: error instanceof Error ? error.name : typeof error,
                });
            }
        }
    }
}
