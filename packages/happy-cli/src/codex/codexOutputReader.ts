import type { Readable } from 'node:stream';

/** A pull reader: a burst chunk cannot dispatch its next line before storage admission. */
export async function readCodexOutput(input: Readable, options: {
    signal: AbortSignal;
    beforeLine: (signal: AbortSignal) => Promise<void>;
    onLine: (line: string) => void;
    maxLineBytes?: number;
}): Promise<void> {
    const limit = options.maxLineBytes ?? 8 * 1024 * 1024;
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Invalid Codex output line limit');
    const controller = new AbortController();
    const signal = controller.signal;
    const forwardAbort = () => controller.abort(new Error('Codex output read aborted'));
    const sourceError = (error: Error) => controller.abort(error);
    const sourceClosed = () => { if (!input.readableEnded) sourceError(new Error('Codex output closed before EOF')); };
    options.signal.addEventListener('abort', forwardAbort, { once: true });
    input.on('error', sourceError); input.on('close', sourceClosed);
    if (options.signal.aborted) forwardAbort();
    try {
        input.pause();
        const aborted = () => signal.reason instanceof Error ? signal.reason : new Error('Codex output read aborted');
        const check = () => { if (signal.aborted) throw aborted(); };
        const admit = async () => {
            check();
            let onAbort!: () => void;
            const cancelled = new Promise<never>((_, reject) => {
                onAbort = () => reject(aborted()); signal.addEventListener('abort', onAbort, { once: true });
            });
            try { await Promise.race([options.beforeLine(signal), cancelled]); check(); }
            finally { signal.removeEventListener('abort', onAbort); }
        };
        const waitForBytes = () => new Promise<void>((resolve, reject) => {
            const finish = (error?: Error) => {
                for (const event of ['readable', 'end']) input.off(event, ready);
                input.off('error', failed); input.off('close', closed);
                signal.removeEventListener('abort', cancelled);
                error ? reject(error) : resolve();
            };
            const ready = () => finish();
            const failed = (error: Error) => finish(error);
            const closed = () => finish(input.readableEnded ? undefined : new Error('Codex output closed before EOF'));
            const cancelled = () => finish(aborted());
            for (const event of ['readable', 'end']) input.once(event, ready);
            input.once('error', failed); input.once('close', closed);
            signal.addEventListener('abort', cancelled, { once: true });
            if (signal.aborted) cancelled();
            else if (input.readableEnded || input.readableLength) ready();
            else if (input.destroyed) closed();
        });
        let fragments: Buffer[] = [];
        let bytes = 0;
        const append = (part: Buffer) => {
            if (bytes + part.length > limit) throw new Error('Codex output line exceeds limit');
            fragments.push(part); bytes += part.length;
        };
        const deliver = async () => {
            await admit();
            const line = Buffer.concat(fragments, bytes).toString('utf8').replace(/\r$/, '');
            fragments = []; bytes = 0;
            options.onLine(line);
        };
        while (true) {
            await admit();
            const chunk: Buffer | null = input.read(input.readableLength ? Math.min(input.readableLength, 64 * 1024) : undefined);
            if (!chunk) {
                if (input.readableEnded) break;
                await waitForBytes(); continue;
            }
            let offset = 0;
            for (let end = chunk.indexOf(10, offset); end !== -1; end = chunk.indexOf(10, offset)) {
                append(chunk.subarray(offset, end)); await deliver(); offset = end + 1;
            }
            if (offset < chunk.length) append(chunk.subarray(offset));
        }
        if (bytes) await deliver();
    } finally {
        options.signal.removeEventListener('abort', forwardAbort);
        input.off('error', sourceError); input.off('close', sourceClosed);
    }
}
