import { createDiffSyntax } from './factory.generated';
import type { SyntaxResult, SyntaxWorker } from './protocol';
import { SyntaxWorkerUnavailableError } from './protocol';

/** Web uses a real Worker; unavailable workers fail plain, never run on JS. */
export function createSyntaxWorker(): SyntaxWorker {
    let worker: Worker | undefined;
    let nextId = 0;
    const pending = new Map<number, { resolve: (result: SyntaxResult) => void; reject: (error: Error) => void }>();
    return {
        run(input) {
            return new Promise((resolve, reject) => {
                if (!worker) {
                    try {
                        // The generated factory is self-contained (tested after
                        // the Worklets Babel transform too). No fetched code.
                        const source = `const tokenize = (${createDiffSyntax.toString()})();\nself.onmessage = ({data}) => {\ntry { self.postMessage({id: data.id, result: tokenize(data.input)}); }\ncatch { self.postMessage({id: data.id, result: null}); }\n};`;
                        const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
                        try { worker = new Worker(url); }
                        finally { URL.revokeObjectURL(url); }
                        worker.onmessage = ({ data }: MessageEvent<{ id: number; result: SyntaxResult | null }>) => {
                            const request = pending.get(data.id);
                            pending.delete(data.id);
                            if (data.result) request?.resolve(data.result);
                            else request?.reject(new Error('Diff syntax worker failed'));
                        };
                        worker.onerror = () => {
                            for (const request of pending.values()) request.reject(new SyntaxWorkerUnavailableError('Diff syntax worker unavailable'));
                            pending.clear();
                            worker?.terminate();
                            worker = undefined;
                        };
                    } catch {
                        reject(new SyntaxWorkerUnavailableError('Diff syntax worker unavailable'));
                        return;
                    }
                }
                const id = ++nextId;
                pending.set(id, { resolve, reject });
                try { worker.postMessage({ id, input }); }
                catch { pending.delete(id); reject(new SyntaxWorkerUnavailableError('Diff syntax worker unavailable')); }
            });
        },
    };
}