import { logger } from "@/ui/logger";
import { existsSync } from "node:fs";
import { watch } from "fs/promises";
import { basename, dirname } from "node:path";

const CREATION_POLL_INTERVAL_MS = 2_000;

export interface FileWatcherOptions {
    /**
     * Called once when the parent directory stays unwatchable for the timeout.
     * A file that has not been created yet is not a give-up condition.
     */
    onGaveUp?: () => void;
    /**
     * How long the parent directory may remain continuously unwatchable.
     * This does not limit how long we wait for the file itself to appear.
     */
    missingFileTimeoutMs?: number;
}


type CreationOutcome = 'created' | 'aborted' | 'unwatchable' | 'retry';

/**
 * Watch a file that may be created after the watcher starts.
 *
 * fs.watch() cannot watch an absent file, so an absent transcript is handled
 * by watching its parent directory and polling as a fallback for filesystems
 * that do not deliver directory events. The timeout only applies when that
 * parent directory itself cannot be watched; Claude creates transcripts
 * lazily, so elapsed time cannot distinguish a valid late file from a bad
 * path.
 */
export function startFileWatcher(
    file: string,
    onFileChange: (file: string) => void,
    options: FileWatcherOptions = {},
) {
    const abortController = new AbortController();
    const missingFileTimeoutMs = options.missingFileTimeoutMs ?? 60_000;
    const directory = dirname(file);
    const filename = basename(file);

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

    const awaitFileCreation = async (): Promise<CreationOutcome> => {
        const directoryAbort = new AbortController();
        let pollTimer: ReturnType<typeof setTimeout> | null = null;
        let pollFound = false;

        const forwardAbort = () => directoryAbort.abort();
        abortController.signal.addEventListener('abort', forwardAbort, { once: true });

        const poll = () => {
            pollTimer = setTimeout(() => {
                if (existsSync(file)) {
                    pollFound = true;
                    directoryAbort.abort();
                    return;
                }
                poll();
            }, CREATION_POLL_INTERVAL_MS);
        };

        try {
            const directoryWatcher = watch(directory, {
                persistent: true,
                signal: directoryAbort.signal,
            });

            // Cover creation between the caller's check and watch() being armed.
            if (existsSync(file)) {
                return 'created';
            }

            poll();
            for await (const event of directoryWatcher) {
                if (abortController.signal.aborted) {
                    return 'aborted';
                }
                const eventName = event.filename?.toString();
                if (!eventName || eventName === filename) {
                    if (existsSync(file)) {
                        logger.debug(`[FILE_WATCHER] File appeared: ${file}`);
                        return 'created';
                    }
                }
            }

            if (abortController.signal.aborted) {
                return 'aborted';
            }
            if (pollFound || existsSync(file)) {
                logger.debug(`[FILE_WATCHER] File appeared (poll): ${file}`);
                return 'created';
            }
            // A directory iterator may end during a benign replacement. Do
            // not infer that the directory is permanently unwatchable.
            return 'retry';
        } catch (error: any) {
            if (abortController.signal.aborted) {
                return 'aborted';
            }
            // Aborting the local directory watch is how the poll wakes this
            // loop on Node, where fs/promises.watch throws AbortError.
            if (pollFound && directoryAbort.signal.aborted) {
                logger.debug(`[FILE_WATCHER] File appeared (poll): ${file}`);
                return 'created';
            }
            logger.debug(`[FILE_WATCHER] Cannot watch directory ${directory}: ${error?.message}`);
            return 'unwatchable';
        } finally {
            if (pollTimer) {
                clearTimeout(pollTimer);
            }
            abortController.signal.removeEventListener('abort', forwardAbort);
            directoryAbort.abort();
        }
    };

    void (async () => {
        let directoryUnwatchableSince: number | null = null;
        let failureCount = 0;

        const backoff = async () => {
            failureCount++;
            const backoffMs = Math.min(1000 * 2 ** Math.min(failureCount - 1, 4), 15_000);
            await wait(backoffMs);
            return backoffMs;
        };

        while (!abortController.signal.aborted) {
            try {
                if (!existsSync(file)) {
                    logger.debug(`[FILE_WATCHER] Waiting for ${file} to be created`);
                    const outcome = await awaitFileCreation();
                    if (abortController.signal.aborted || outcome === 'aborted') {
                        return;
                    }
                    if (outcome === 'unwatchable') {
                        const now = Date.now();
                        directoryUnwatchableSince ??= now;
                        const unwatchableMs = now - directoryUnwatchableSince;
                        if (unwatchableMs >= missingFileTimeoutMs) {
                            logger.debug(`[FILE_WATCHER] Giving up on ${file}: directory ${directory} unwatchable for ${Math.round(unwatchableMs / 1000)}s`);
                            options.onGaveUp?.();
                            return;
                        }
                        await backoff();
                        continue;
                    }

                    directoryUnwatchableSince = null;
                    if (outcome === 'retry') {
                        await wait(200);
                        continue;
                    }

                    // The creation event happened before the file watcher was
                    // armed, so notify the scanner once for its initial content.
                    onFileChange(file);
                }

                directoryUnwatchableSince = null;
                logger.debug(`[FILE_WATCHER] Starting watcher for ${file}`);
                const watcher = watch(file, {
                    persistent: true,
                    signal: abortController.signal,
                });
                for await (const event of watcher) {
                    if (abortController.signal.aborted) {
                        return;
                    }
                    // Only a delivered event proves that this watch is healthy.
                    failureCount = 0;
                    logger.debug(`[FILE_WATCHER] File changed: ${file}`);
                    onFileChange(file);
                }

                // Avoid a hot loop if the platform closes a watcher without an
                // error while the file is still present.
                if (existsSync(file)) {
                    await wait(200);
                }
            } catch (error: any) {
                if (abortController.signal.aborted) {
                    return;
                }
                if (error?.code === 'ENOENT') {
                    logger.debug(`[FILE_WATCHER] File disappeared, waiting for it to return: ${file}`);
                    await wait(200);
                    continue;
                }

                const backoffMs = await backoff();
                logger.debug(`[FILE_WATCHER] Watch error: ${error?.message}, retrying in ${backoffMs}ms`);
            }
        }
    })();

    return () => {
        abortController.abort();
    };
}