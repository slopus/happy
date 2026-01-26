import type { Readable, Writable } from 'node:stream';
import { logger } from '@/ui/logger';

/**
 * Convert Node.js streams to Web Streams for ACP SDK.
 */
export function nodeToWebStreams(
    stdin: Writable,
    stdout: Readable,
): { writable: WritableStream<Uint8Array>; readable: ReadableStream<Uint8Array> } {
    const writable = new WritableStream<Uint8Array>({
        write(chunk) {
            return new Promise((resolve, reject) => {
                let drained = false;
                let wrote = false;
                let settled = false;

                const onDrain = () => {
                    drained = true;
                    if (!wrote) return;
                    if (settled) return;
                    settled = true;
                    stdin.off('drain', onDrain);
                    resolve();
                };

                // Register the drain handler up-front to avoid missing a synchronous `drain` emission
                // from custom Writable implementations (or odd edge cases).
                stdin.once('drain', onDrain);

                const ok = stdin.write(chunk, (err) => {
                    wrote = true;
                    if (err) {
                        logger.debug(`[nodeToWebStreams] Error writing to stdin:`, err);
                        if (!settled) {
                            settled = true;
                            stdin.off('drain', onDrain);
                            reject(err);
                        }
                        return;
                    }

                    if (ok) {
                        if (!settled) {
                            settled = true;
                            stdin.off('drain', onDrain);
                            resolve();
                        }
                        return;
                    }

                    if (drained && !settled) {
                        settled = true;
                        stdin.off('drain', onDrain);
                        resolve();
                    }
                });

                drained = drained || ok;
                if (ok) {
                    // No drain will be emitted for this write; remove the listener immediately.
                    stdin.off('drain', onDrain);
                }
            });
        },
        close() {
            return new Promise((resolve) => {
                stdin.end(resolve);
            });
        },
        abort(reason) {
            stdin.destroy(reason instanceof Error ? reason : new Error(String(reason)));
        },
    });

    const readable = new ReadableStream<Uint8Array>({
        start(controller) {
            stdout.on('data', (chunk: Buffer) => {
                controller.enqueue(new Uint8Array(chunk));
            });
            stdout.on('end', () => {
                controller.close();
            });
            stdout.on('error', (err) => {
                logger.debug(`[nodeToWebStreams] Stdout error:`, err);
                controller.error(err);
            });
        },
        cancel() {
            stdout.destroy();
        },
    });

    return { writable, readable };
}
