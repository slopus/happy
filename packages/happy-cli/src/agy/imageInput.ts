/**
 * Agy image input preparation
 *
 * agy has no image-input flag; its only viable image path is the filesystem:
 * decode the wire attachments into a session-scoped cache dir, expose that dir
 * via `--add-dir`, and reference the file paths in the prompt. Decoding and
 * cache-dir layout are reused from the Codex helpers (same magic-byte
 * detection, same permissions), only the cache root differs.
 *
 * Isolation is guaranteed by directory structure, not prompt wording: given a
 * nonexistent path agy has been observed to scan the surrounding directory and
 * describe unrelated files, so the session dir must contain only this
 * session's attachments and must never point at a shared location.
 */

import { createHash } from 'node:crypto';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import type { PendingAttachment } from '@/utils/MessageQueue2';

import { prepareCodexImageInputItems, resolveCodexImageCacheDir } from '@/codex/utils/imageInput';

function agyImageCacheRoot(cacheRootDir?: string): string {
    return cacheRootDir ?? join(configuration.happyHomeDir, 'agy-image-cache');
}

/**
 * Collision-proof per-session directory segment. The codex sanitizer is not
 * injective ('a/b' and 'a_b' collide) and degenerate ids collapse into fixed
 * shared buckets — unacceptable here because the dir is handed to --add-dir
 * and rm -rf'd at session end, so two sessions must never share a dir even
 * for hostile server-issued ids. Hashing the raw id makes that structural.
 */
function sessionCacheKey(sessionId: string): string {
    return createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
}

export type PreparedAgyImages = {
    /** Absolute paths of the decoded image files, in attachment order. */
    paths: string[];
    /** Attachments dropped because their bytes matched no supported format. */
    skipped: number;
    /** Session cache dir holding the files; null when nothing was written. */
    cacheDir: string | null;
};

export async function prepareAgyImageFiles(
    attachments: PendingAttachment[] | undefined,
    opts: {
        sessionId: string;
        cacheRootDir?: string;
    },
): Promise<PreparedAgyImages> {
    const prepared = await prepareCodexImageInputItems(attachments, {
        sessionId: sessionCacheKey(opts.sessionId),
        cacheRootDir: agyImageCacheRoot(opts.cacheRootDir),
    });
    const paths = prepared.inputItems.flatMap((item) => (item.type === 'localImage' ? [item.path] : []));
    return {
        paths,
        skipped: prepared.skipped,
        cacheDir: paths.length > 0
            ? resolveCodexImageCacheDir({
                sessionId: sessionCacheKey(opts.sessionId),
                cacheRootDir: agyImageCacheRoot(opts.cacheRootDir),
            })
            : null,
    };
}

/** Best-effort removal of the session's image cache dir (session end). */
export async function cleanupAgyImageCache(opts: {
    sessionId: string;
    cacheRootDir?: string;
}): Promise<void> {
    const cacheDir = resolveCodexImageCacheDir({
        sessionId: sessionCacheKey(opts.sessionId),
        cacheRootDir: agyImageCacheRoot(opts.cacheRootDir),
    });
    try {
        await rm(cacheDir, { recursive: true, force: true });
    } catch (error) {
        logger.debug('[agy] Failed to clean image cache', {
            errorName: error instanceof Error ? error.name : typeof error,
        });
    }
}

const STALE_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Best-effort sweep of session dirs left behind by hard exits: a bare SIGTERM
 * (the daemon's stop signal) can skip the session-end cleanup, and dirs are
 * keyed by hashed session id, so nothing else ever revisits them. Age-gated so
 * a concurrent live session's fresh dir is never touched.
 */
export async function sweepStaleAgyImageCache(opts: {
    cacheRootDir?: string;
    maxAgeMs?: number;
    now?: () => number;
} = {}): Promise<void> {
    const root = agyImageCacheRoot(opts.cacheRootDir);
    const maxAgeMs = opts.maxAgeMs ?? STALE_CACHE_MAX_AGE_MS;
    const now = opts.now ?? Date.now;
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    } catch {
        return; // no cache root yet — nothing to sweep
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = join(root, entry.name);
        try {
            const info = await stat(dir);
            if (now() - info.mtimeMs > maxAgeMs) {
                await rm(dir, { recursive: true, force: true });
            }
        } catch (error) {
            logger.debug('[agy] Failed to sweep stale image cache dir', {
                errorName: error instanceof Error ? error.name : typeof error,
            });
        }
    }
}

/**
 * Prefix the turn prompt with the attached file paths. The "ONLY these exact
 * paths" instruction is belt on top of the directory-isolation suspenders —
 * assume it may be ignored; the cache dir layout is what actually bounds agy.
 */
export function buildAgyImagePrompt(userText: string, paths: string[]): string {
    if (paths.length === 0) {
        return userText;
    }
    const list = paths.map((p) => `- ${p}`).join('\n');
    const noun = paths.length === 1 ? 'an image file' : `${paths.length} image files`;
    const header = `The user attached ${noun} to this message. Read and consider ONLY these exact file paths; if one does not exist, say so instead of searching for other files:\n${list}`;
    const text = userText.trim();
    return text.length > 0 ? `${header}\n\n${userText}` : header;
}
