import { logger } from "@/ui/logger";
import { watch } from "fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";

/** How often we re-check existence while waiting for a file to be created. */
const CREATION_POLL_INTERVAL_MS = 2000;

export interface FileWatcherOptions {
    /**
     * Invoked exactly once when the watcher permanently gives up. This only
     * happens when the file's parent directory stays unwatchable for
     * `missingFileTimeoutMs` (e.g. it does not exist, or permissions deny
     * watching) — never merely because the file itself has not been created
     * yet. The watcher loop exits right after; the caller owns any follow-up
     * cleanup (e.g. dropping the dead session so it is never re-watched).
     */
    onGaveUp?: () => void;
    /**
     * How long the parent directory may stay *continuously* unwatchable before
     * we give up. Defaults to 60s. This does NOT bound how long we wait for the
     * file itself — see the module docs below for why.
     */
    missingFileTimeoutMs?: number;
}

type CreationOutcome =
    /** The file now exists. */
    | 'created'
    /** We were disposed. */
    | 'aborted'
    /** The parent directory could not be watched at all (missing, EACCES, ...). */
    | 'unwatchable'
    /** Nothing conclusive; the caller should simply loop and try again. */
    | 'retry';

/**
 * Watch a single file for changes, tolerating a file that does not exist yet.
 *
 * `fs.watch()` throws `ENOENT` synchronously for a path that does not exist.
 * An earlier implementation (tight `while (true)` + flat `delay(1000)`) turned
 * a never-created session transcript into an infinite 1-per-second spin, which
 * pegged the CPU and flooded the log — the "dead Happy instance" bug. That was
 * fixed by bounding total absence with a 60s timeout and giving up.
 *
 * Bounding by time is the wrong cure, because "not created yet" and "never
 * going to be created" are indistinguishable by elapsed time. Claude Code
 * creates `<uuid>.jsonl` lazily — not at launch, but when the user submits
 * their first prompt. A user who starts Happy, reads some code, and types
 * their first prompt 90 seconds later would trip the timeout, and the watcher
 * would give up ~an instant before the file appeared. The session then stays
 * registered (the phone shows it as online with a title) but no message is
 * ever uploaded, and it cannot recover for the rest of its lifetime.
 *
 * So instead of racing a timer, wait for the file to be *created*: when it is
 * absent, watch the parent directory and block until the entry shows up.
 *
 * That wait races a low-frequency existence poll. Pure event-driven waiting
 * would hang forever on filesystems that do not deliver watch events at all
 * (NFS, SMB, some container bind mounts) — reproducing the very bug above,
 * only quieter. The poll is the safety net; events remain the fast path, so
 * there is no per-second spin and no log flood.
 *
 * This version:
 *  - waits indefinitely for a not-yet-created file, via directory events
 *    raced against a slow poll,
 *  - backs off exponentially (1s → 15s, capped) on transient watch errors,
 *  - gives up only if the parent directory itself stays continuously
 *    unwatchable past `missingFileTimeoutMs`, signalling via `onGaveUp`,
 *  - resets failure state only on observed progress, so a persistent error
 *    (EACCES, EMFILE) escalates to the 15s cap instead of retrying every
 *    second forever,
 *  - re-arms if the file is deleted later, waiting for it to reappear.
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

    /**
     * Block until `file` exists, by watching its parent directory while also
     * polling for existence.
     *
     * The two are raced deliberately: the event path reacts instantly on
     * healthy filesystems, the poll guarantees eventual progress on ones that
     * never deliver events. Distinguishing 'unwatchable' from 'retry' matters
     * — only the former may start the give-up countdown, and a directory
     * iterator ending on its own (a rename, or Node closing it) is benign.
     */
    const awaitFileCreation = async (): Promise<CreationOutcome> => {
        // Own abort controller for the directory watch so every exit path
        // (file found, abort, throw) releases it. Returning straight out of a
        // `for await` — or never iterating it at all, as happens when the
        // existence re-check below wins the race — would otherwise leave the
        // underlying OS watch armed until GC: one leaked watch per session.
        const directoryAbort = new AbortController();
        const forwardAbort = () => directoryAbort.abort();
        abortController.signal.addEventListener('abort', forwardAbort, { once: true });

        // Wakes the loop below on a timer even if no event ever arrives.
        let pollTimer: NodeJS.Timeout | null = null;
        const startPoll = () => {
            pollTimer = setTimeout(() => {
                if (existsSync(file)) {
                    directoryAbort.abort();
                } else {
                    startPoll();
                }
            }, CREATION_POLL_INTERVAL_MS);
        };

        try {
            const directoryWatcher = watch(directory, { persistent: true, signal: directoryAbort.signal });

            // The file may have been created between the caller's existence
            // check and this watch being armed — re-check before blocking, or
            // we would wait for an event that has already happened.
            if (existsSync(file)) {
                return 'created';
            }

            startPoll();

            for await (const event of directoryWatcher) {
                if (abortController.signal.aborted) {
                    return 'aborted';
                }
                // `filename` is null on some platforms/events; re-check on any
                // directory activity rather than trusting the name.
                if (!event.filename || event.filename === filename) {
                    if (existsSync(file)) {
                        logger.debug(`[FILE_WATCHER] File appeared: ${file}`);
                        return 'created';
                    }
                }
            }

            // Iterator ended. Either our poll found the file and aborted the
            // watch, or the directory went away / Node closed it. Existence
            // decides which — never report 'unwatchable' on a guess, because
            // that is what arms the give-up countdown.
            if (abortController.signal.aborted) {
                return 'aborted';
            }
            if (existsSync(file)) {
                logger.debug(`[FILE_WATCHER] File appeared (poll): ${file}`);
                return 'created';
            }
            return 'retry';
        } catch (e: any) {
            if (abortController.signal.aborted) {
                return 'aborted';
            }
            // The directory itself cannot be watched — this, and only this, is
            // what `missingFileTimeoutMs` guards.
            logger.debug(`[FILE_WATCHER] Cannot watch directory ${directory}: ${e?.message}`);
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
        // When the parent directory first became unwatchable (null = fine, or
        // never-yet-failed). Reset the moment the directory is watchable again,
        // so an early transient failure cannot make a much later, unrelated
        // failure trip the deadline with zero grace.
        let directoryUnwatchableSince: number | null = null;
        let failureCount = 0;

        const backoff = async () => {
            failureCount++;
            const backoffMs = Math.min(1000 * 2 ** Math.min(failureCount - 1, 4), 15_000);
            await wait(backoffMs);
            return backoffMs;
        };

        while (true) {
            if (abortController.signal.aborted) {
                return;
            }
            try {
                // Wait for a not-yet-created transcript instead of failing on
                // ENOENT and racing a deadline.
                if (!existsSync(file)) {
                    logger.debug(`[FILE_WATCHER] Waiting for ${file} to be created`);
                    const outcome = await awaitFileCreation();
                    if (abortController.signal.aborted || outcome === 'aborted') {
                        return;
                    }
                    if (outcome === 'unwatchable') {
                        const now = Date.now();
                        if (directoryUnwatchableSince === null) {
                            directoryUnwatchableSince = now;
                        }
                        const unwatchableMs = now - directoryUnwatchableSince;
                        if (unwatchableMs >= missingFileTimeoutMs) {
                            logger.debug(`[FILE_WATCHER] Giving up on ${file}: directory ${directory} unwatchable for ${Math.round(unwatchableMs / 1000)}s`);
                            options.onGaveUp?.();
                            return;
                        }
                        await backoff();
                        continue;
                    }
                    // Watchable again (created or benign retry): clear the
                    // give-up clock so it only ever measures a continuous
                    // unwatchable stretch.
                    directoryUnwatchableSince = null;
                    if (outcome === 'retry') {
                        continue;
                    }
                }

                // Directory is demonstrably fine at this point.
                directoryUnwatchableSince = null;

                logger.debug(`[FILE_WATCHER] Starting watcher for ${file}`);
                const watcher = watch(file, { persistent: true, signal: abortController.signal });
                for await (const event of watcher) {
                    if (abortController.signal.aborted) {
                        return;
                    }
                    // Only an actually delivered event proves the watch works.
                    // Resetting before arming would pin a persistently failing
                    // watch (EACCES, EMFILE) at the 1s floor forever.
                    failureCount = 0;
                    logger.debug(`[FILE_WATCHER] File changed: ${file}`);
                    onFileChange(file);
                }
                // Iterator ended without an abort (rare, e.g. the file was
                // replaced); fall through and re-arm.
            } catch (e: any) {
                if (abortController.signal.aborted) {
                    return;
                }

                // ENOENT here means the file vanished after we started
                // watching it. The loop re-arms and waits for it to reappear,
                // so this is not a give-up condition either.
                if (e?.code !== 'ENOENT') {
                    const backoffMs = await backoff();
                    logger.debug(`[FILE_WATCHER] Watch error: ${e?.message}, retried after ${backoffMs}ms`);
                } else {
                    logger.debug(`[FILE_WATCHER] File disappeared, waiting for it to return: ${file}`);
                    // Normally the next loop blocks in awaitFileCreation, but if
                    // existsSync() and watch() disagree (a delete racing us) we
                    // could spin hot. A short pause bounds that to a slow poll.
                    await wait(200);
                }
            }
        }
    })();

    return () => {
        abortController.abort();
    };
}
