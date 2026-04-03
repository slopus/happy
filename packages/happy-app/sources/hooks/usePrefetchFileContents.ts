/**
 * Impression-based prefetch for file contents.
 *
 * When the file list is rendered, this hook prefetches file content + diff
 * for all non-deleted, non-binary files that aren't already in the Zustand
 * cache. This way, tapping into a file shows content instantly.
 *
 * Prefetch runs with limited concurrency (3 at a time) to avoid overloading
 * the session with too many RPC calls. Deleted and binary files are skipped.
 */

import * as React from 'react';
import { sessionReadFile, sessionBash } from '@/sync/ops';
import { storage } from '@/sync/storage';
import { resolveSessionFilePath } from '@/utils/sessionFileLinks';
import type { GitFileStatus, GitStatusFiles } from '@/sync/gitStatusFiles';

const BINARY_EXTENSIONS = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'ico',
    'mp4', 'avi', 'mov', 'wmv', 'flv', 'webm',
    'mp3', 'wav', 'flac', 'aac', 'ogg',
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
    'zip', 'tar', 'gz', 'rar', '7z',
    'exe', 'dmg', 'deb', 'rpm',
    'woff', 'woff2', 'ttf', 'otf',
    'db', 'sqlite', 'sqlite3',
]);

function isBinaryPath(path: string): boolean {
    const ext = path.split('.').pop()?.toLowerCase();
    return ext ? BINARY_EXTENSIONS.has(ext) : false;
}

function decodeBase64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

/**
 * Prefetch a single file's content + diff into the Zustand cache.
 * Silently swallows errors — prefetch is best-effort.
 */
async function prefetchFile(sessionId: string, sessionPath: string, file: GitFileStatus): Promise<void> {
    const resolved = resolveSessionFilePath(file.fullPath, sessionPath);
    const filePath = resolved?.absolutePath ?? file.fullPath;
    const gitDiffPath = resolved?.withinSessionRoot ? resolved.relativePath : null;

    let diff: string | null = null;

    // Fetch git diff
    if (gitDiffPath && gitDiffPath !== '.') {
        try {
            const diffResponse = await sessionBash(sessionId, {
                command: `git diff --no-ext-diff -- "${gitDiffPath}"`,
                cwd: sessionPath,
                timeout: 5000,
            });
            if (diffResponse.success && diffResponse.stdout.trim()) {
                diff = diffResponse.stdout;
            }
        } catch {
            // Best-effort
        }
    }

    // Fetch file content
    try {
        const response = await sessionReadFile(sessionId, filePath);
        if (response.success && response.content) {
            let rawBytes: Uint8Array;
            let decodedContent: string;
            try {
                rawBytes = decodeBase64ToBytes(response.content);
                decodedContent = new TextDecoder().decode(rawBytes);
            } catch {
                storage.getState().applyFileCache(sessionId, filePath, '', diff, true);
                return;
            }

            const hasNullBytes = rawBytes.some((byte) => byte === 0);
            const nonPrintableCount = decodedContent.split('').filter((char) => {
                const code = char.charCodeAt(0);
                return code < 32 && code !== 9 && code !== 10 && code !== 13;
            }).length;
            const isBinary = hasNullBytes || (nonPrintableCount / decodedContent.length > 0.1);

            storage.getState().applyFileCache(
                sessionId,
                filePath,
                isBinary ? '' : decodedContent,
                diff,
                isBinary,
            );
        }
    } catch {
        // Best-effort
    }
}

const MAX_CONCURRENCY = 3;

export function usePrefetchFileContents(sessionId: string, gitStatusFiles: GitStatusFiles | null) {
    React.useEffect(() => {
        if (!gitStatusFiles) return;

        const session = storage.getState().sessions[sessionId];
        const sessionPathMaybe = session?.metadata?.path;
        if (!sessionPathMaybe) return;
        const sessionPath: string = sessionPathMaybe;

        const existingCache = storage.getState().sessionFileCache[sessionId] || {};

        // Collect files that need prefetching: non-deleted, non-binary, not cached
        const filesToPrefetch: GitFileStatus[] = [];
        const allFiles = [...gitStatusFiles.stagedFiles, ...gitStatusFiles.unstagedFiles];
        const seen = new Set<string>();

        for (const file of allFiles) {
            if (file.status === 'deleted') continue;
            if (isBinaryPath(file.fullPath)) continue;
            if (seen.has(file.fullPath)) continue;
            seen.add(file.fullPath);

            // Check if already cached by resolving the path the same way file.tsx does
            const resolved = resolveSessionFilePath(file.fullPath, sessionPath);
            const absolutePath = resolved?.absolutePath ?? file.fullPath;
            if (existingCache[absolutePath]) continue;

            filesToPrefetch.push(file);
        }

        if (filesToPrefetch.length === 0) return;

        let cancelled = false;

        // Run prefetch with limited concurrency
        (async () => {
            let i = 0;
            async function next(): Promise<void> {
                while (!cancelled) {
                    const idx = i++;
                    if (idx >= filesToPrefetch.length) return;
                    await prefetchFile(sessionId, sessionPath, filesToPrefetch[idx]);
                }
            }

            const workers = Array.from(
                { length: Math.min(MAX_CONCURRENCY, filesToPrefetch.length) },
                () => next(),
            );
            await Promise.all(workers);
        })();

        return () => {
            cancelled = true;
        };
    }, [sessionId, gitStatusFiles]);
}
