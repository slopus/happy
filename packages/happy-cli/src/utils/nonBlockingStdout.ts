/**
 * Non-blocking stdout wrapper for Ink rendering.
 *
 * When tmux detaches, the PTY buffer fills up and process.stdout.write()
 * blocks synchronously, freezing the Node.js event loop. This wrapper
 * drops writes when backpressure is detected instead of blocking.
 *
 * Used by Ink's render() stdout option to prevent multiple Happy instances
 * from stalling in detached tmux sessions.
 *
 * See: https://github.com/slopus/happy/issues/533
 */

import { WriteStream } from 'node:tty';
import { logger } from '@/ui/logger';

export function createNonBlockingStdout(): WriteStream {
    let dropping = false;
    let droppedWrites = 0;

    // Create a proxy around process.stdout that intercepts write()
    // to drop data when backpressure is detected (e.g. tmux detached).
    // All other properties/methods delegate to the real stdout.
    const proxy = new Proxy(process.stdout, {
        get(target, prop, receiver) {
            if (prop === 'write') {
                return function write(chunk: any, encodingOrCallback?: any, callback?: any) {
                    // Resolve overloaded arguments
                    let encoding: BufferEncoding | undefined;
                    let cb: ((err?: Error | null) => void) | undefined;
                    if (typeof encodingOrCallback === 'function') {
                        cb = encodingOrCallback;
                    } else {
                        encoding = encodingOrCallback;
                        cb = callback;
                    }

                    // If stdout already has backpressure, drop the write.
                    // Returns true so Ink doesn't apply its own backpressure handling.
                    if (target.writableNeedDrain) {
                        if (!dropping) {
                            dropping = true;
                            logger.debug('[nonBlockingStdout] Backpressure detected, dropping writes (tmux likely detached)');
                        }
                        droppedWrites++;
                        cb?.();
                        return true;
                    }

                    const ok = encoding
                        ? target.write(chunk, encoding, cb)
                        : target.write(chunk, cb);

                    if (!ok) {
                        if (!dropping) {
                            dropping = true;
                            logger.debug('[nonBlockingStdout] Write returned false, will drop until drain');
                            target.once('drain', () => {
                                logger.debug(`[nonBlockingStdout] Drain received, resuming writes (dropped ${droppedWrites} writes while detached)`);
                                dropping = false;
                                droppedWrites = 0;
                            });
                        }
                    } else if (dropping) {
                        logger.debug(`[nonBlockingStdout] Writes resumed (dropped ${droppedWrites} writes while detached)`);
                        dropping = false;
                        droppedWrites = 0;
                    }

                    return ok;
                };
            }
            return Reflect.get(target, prop, receiver);
        }
    });

    return proxy;
}
