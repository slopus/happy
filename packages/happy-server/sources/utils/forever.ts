import { AbortedExeption } from "./aborted";
import { backoff } from "./backoff";
import { keepAlive, shutdownSignal } from "./shutdown";

export async function forever(
    name: string,
    callback: () => Promise<void>
) {
    keepAlive(name, async () => {
        await backoff(async () => {
            while (!shutdownSignal.aborted) {
                try {
                    await callback();
                } catch (error) {
                    if (AbortedExeption.isAborted(error)) {
                        break;
                    } else {
                        throw error;
                    }
                }
            }
        });
    });
}