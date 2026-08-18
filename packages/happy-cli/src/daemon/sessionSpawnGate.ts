import type { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';

export function createSessionSpawnGate(
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>,
) {
    const active = new Set<Promise<SpawnSessionResult>>();
    let accepting = true;

    const run = (operationFactory: () => Promise<SpawnSessionResult>): Promise<SpawnSessionResult> => {
        if (!accepting) {
            return Promise.resolve({
                type: 'error',
                errorMessage: 'Daemon is shutting down and cannot start another session',
            });
        }
        const operation = operationFactory();
        active.add(operation);
        void operation.then(
            () => active.delete(operation),
            () => active.delete(operation),
        );
        return operation;
    };

    return {
        spawn(options: SpawnSessionOptions): Promise<SpawnSessionResult> {
            return run(() => spawnSession(options));
        },
        run,
        async fenceAndDrain(): Promise<number> {
            accepting = false;
            const inFlight = Array.from(active);
            await Promise.allSettled(inFlight);
            return inFlight.length;
        },
        activeCount(): number {
            return active.size;
        },
    };
}
