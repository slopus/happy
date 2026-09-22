export type ContinuationRecord = { phase: 'starting' } | { phase: 'created' | 'ready'; sessionId: string };
export interface ContinuationDependencies {
    read(source: string): ContinuationRecord | undefined;
    write(source: string, value: ContinuationRecord): void;
    spawn(source: string): Promise<string>;
    link(source: string, target: string): Promise<void>;
    assertCurrent(): void;
}

/** Shared across menu/screen instances. A persisted receipt survives reloads. */
export function createContinuationCoordinator(deps: ContinuationDependencies) {
    const inFlight = new Map<string, Promise<string>>();
    return (source: string): Promise<string> => {
        const running = inFlight.get(source);
        if (running) return running;
        const run = async () => {
            deps.assertCurrent();
            let record = deps.read(source);
            if (record?.phase === 'starting') throw new Error('continuation-outcome-unknown');
            if (!record) {
                deps.write(source, { phase: 'starting' });
                const sessionId = await deps.spawn(source);
                // Save the receipt even if the account changed while spawn ran.
                deps.write(source, { phase: 'created', sessionId });
                record = { phase: 'created', sessionId };
            }
            deps.assertCurrent();
            if (record.phase !== 'ready') {
                await deps.link(source, record.sessionId);
                deps.assertCurrent();
                deps.write(source, { phase: 'ready', sessionId: record.sessionId });
            }
            return record.sessionId;
        };
        const promise = run().finally(() => { inFlight.delete(source); });
        inFlight.set(source, promise);
        return promise;
    };
}
