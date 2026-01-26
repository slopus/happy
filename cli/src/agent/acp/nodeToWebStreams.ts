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
                let settled = false;
                let drained = false;
                let wrote = false;

                const onDrain = () => {
                    drained = true;
                    if (wrote && !settled) {
                        settled = true;
                        resolve();
                    }
                };

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
                            resolve();
                        }
                        return;
                    }

                    if (drained && !settled) {
                        settled = true;
                        resolve();
                    }
                });

                drained = ok;
                if (!ok) stdin.once('drain', onDrain);
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
