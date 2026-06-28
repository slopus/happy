import { logger } from "@/ui/logger";
import { watch } from "fs/promises";

export interface FileWatcherOptions {
    /**
     * Invoked exactly once when the watcher permanently gives up because the
     * target file never appeared within `missingFileTimeoutMs`. The watcher
     * loop exits right after; the caller owns any follow-up cleanup (e.g.
     * dropping the dead session so it is never re-watched).
     */
    onGaveUp?: () => void;
    /**
     * How long the file may stay continuously absent before we give up.
     * Defaults to 60s — comfortably longer than a legitimately slow Claude
     * session start (claudeRemote waits ~10s for the transcript), but bounded
     * so a session id that never produces a file cannot wedge the process.
     */
    missingFileTimeoutMs?: number;
}

/**
 * Watch a single file for changes.
 *
 * `fs.watch()` throws `ENOENT` synchronously for a path that does not exist,
 * so the previous implementation (tight `while (true)` + flat `delay(1000)`)
 * turned a never-created session transcript into an infinite 1-per-second
 * spin. Combined with the session scanner re-adding the watcher every sync
 * cycle, that produced the pegged-CPU / multi-MB-log "dead Happy instance"
 * where the terminal agent kept working but the bridge never recovered.
 *
 * This version:
 *  - backs off exponentially between retries (1s → 15s, capped),
 *  - distinguishes "file absent" (ENOENT) from transient watch errors,
 *  - gives up — instead of spinning forever — when the file stays absent
 *    past `missingFileTimeoutMs`, signalling the caller via `onGaveUp`,
 *  - resets all failure state as soon as the file is observed, so a slow
 *    session start that eventually writes its transcript heals cleanly.
 */
export function startFileWatcher(
    file: string,
    onFileChange: (file: string) => void,
    options: FileWatcherOptions = {},
) {
    const abortController = new AbortController();
    const missingFileTimeoutMs = options.missingFileTimeoutMs ?? 60_000;

    // Timeout/abort-aware wait so a long backoff does not delay cleanup.
    const wait = (ms: number) => new Promise<void>((resolve) => {
        if (abortController.signal.aborted) {
            resolve();
            return;
        }
        const timer = setTimeout(() => {
            abortController.signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            resolve();
        };
        abortController.signal.addEventListener('abort', onAbort, { once: true });
    });

    void (async () => {
        // When the target file first went missing (null = currently present
        // or never-yet-missing). Used to bound total absence time.
        let missingSince: number | null = null;
        let failureCount = 0;

        while (true) {
            try {
                logger.debug(`[FILE_WATCHER] Starting watcher for ${file}`);
                const watcher = watch(file, { persistent: true, signal: abortController.signal });
                for await (const event of watcher) {
                    if (abortController.signal.aborted) {
                        return;
                    }
                    // The file exists and is being watched — clear failure state.
                    missingSince = null;
                    failureCount = 0;
                    logger.debug(`[FILE_WATCHER] File changed: ${file}`);
                    onFileChange(file);
                }
                // Iterator ended without an abort (rare); fall through to retry.
            } catch (e: any) {
                if (abortController.signal.aborted) {
                    return;
                }

                const isMissing = e?.code === 'ENOENT';
                if (isMissing) {
                    const now = Date.now();
                    if (missingSince === null) {
                        missingSince = now;
                    }
                    const absentMs = now - missingSince;
                    if (absentMs >= missingFileTimeoutMs) {
                        logger.debug(`[FILE_WATCHER] Giving up on ${file}: never appeared after ${Math.round(absentMs / 1000)}s`);
                        options.onGaveUp?.();
                        return;
                    }
                } else {
                    // Transient error on an (assumed) existing file: back off
                    // and keep retrying, but do not count it as "missing".
                    missingSince = null;
                }

                failureCount++;
                const backoffMs = Math.min(1000 * 2 ** Math.min(failureCount - 1, 4), 15_000);
                logger.debug(`[FILE_WATCHER] Watch error: ${e.message}, retrying in ${backoffMs}ms`);
                await wait(backoffMs);
            }
        }
    })();

    return () => {
        abortController.abort();
    };
}
