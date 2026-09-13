import { createWorkletRuntime, scheduleOnRN, scheduleOnRuntime, type WorkletRuntime } from 'react-native-worklets';
import { createDiffSyntax } from './factory.generated';
import type { SyntaxInput, SyntaxResult, SyntaxWorker } from './protocol';
import { SyntaxWorkerUnavailableError } from './protocol';

/** Exactly one dedicated Hermes runtime, never the animation/UI runtime. */
export function createSyntaxWorker(): SyntaxWorker {
    let runtime: WorkletRuntime | undefined;
    let nextId = 0;
    const pending = new Map<number, { resolve: (result: SyntaxResult) => void; reject: (error: Error) => void }>();
    const complete = (id: number, json: string | null) => {
        const request = pending.get(id);
        pending.delete(id);
        if (!json) { request?.reject(new Error('Diff syntax worker failed')); return; }
        try {
            const start = performance.now();
            const result = JSON.parse(json) as SyntaxResult;
            const elapsed = performance.now() - start;
            if (elapsed > 2 || (typeof __DEV__ !== 'undefined' && __DEV__)) {
                console.log(`[perf] diff syntax receive=${elapsed.toFixed(1)}ms bytes=${json.length * 2}`);
            }
            request?.resolve(result);
        } catch { request?.reject(new Error('Diff syntax worker returned invalid JSON')); }
    };

    return {
        run(input) {
            return new Promise((resolve, reject) => {
                const id = ++nextId;
                try {
                    if (!runtime) {
                        const start = performance.now();
                        // Initializers run synchronously on the calling thread.
                        // Load Prism in the scheduled job below, NOT here.
                        runtime = createWorkletRuntime({ name: 'happy-diff-syntax' });
                        console.log(`[perf] diff syntax runtime startup=${(performance.now() - start).toFixed(1)}ms`);
                    }
                    pending.set(id, { resolve, reject });
                    // A single string crosses JSI, rather than thousands of
                    // individually serialized row/span objects on both threads.
                    const payload = JSON.stringify(input);
                    scheduleOnRuntime(runtime, (jobId: number, serialized: string) => {
                        'worklet';
                        const globals = globalThis as typeof globalThis & {
                            __happyDiffSyntax?: (input: SyntaxInput) => SyntaxResult;
                        };
                        try {
                            if (!globals.__happyDiffSyntax) globals.__happyDiffSyntax = createDiffSyntax();
                            const result = globals.__happyDiffSyntax!(JSON.parse(serialized));
                            scheduleOnRN(complete, jobId, JSON.stringify(result));
                        } catch {
                            scheduleOnRN(complete, jobId, null);
                        }
                    }, id, payload);
                } catch (error) {
                    pending.delete(id);
                    reject(new SyntaxWorkerUnavailableError(error instanceof Error ? error.message : 'Diff syntax runtime unavailable'));
                }
            });
        },
    };
}