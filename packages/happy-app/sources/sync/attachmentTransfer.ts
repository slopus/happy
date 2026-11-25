export type AttachmentTransferProgress = { bytesWritten: number; totalBytes?: number };
export type AttachmentTransferOptions = {
    signal?: AbortSignal;
    onProgress?: (progress: AttachmentTransferProgress) => void;
    stallTimeoutMs?: number;
};

export function transferAbortReason(signal: AbortSignal): unknown {
    if (signal.reason !== undefined) return signal.reason;
    const error = new Error('Attachment transfer cancelled');
    error.name = 'AbortError';
    return error;
}

/** RN's AbortSignal does not implement throwIfAborted/timeout. */
export function waitForAttachmentTransfer<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return operation;
    if (signal.aborted) {
        void operation.catch(() => {});
        return Promise.reject(transferAbortReason(signal));
    }
    return new Promise<T>((resolve, reject) => {
        const abort = () => { cleanup(); reject(transferAbortReason(signal)); };
        const cleanup = () => signal.removeEventListener('abort', abort);
        signal.addEventListener('abort', abort);
        operation.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
}

export class AttachmentTransferTimeoutError extends Error {
    constructor() {
        super('Attachment transfer timed out');
        this.name = 'AttachmentTransferTimeoutError';
    }
}

/** One bounded operation; the timer never starts another request. */
export async function withAttachmentDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new AttachmentTransferTimeoutError()); controller.abort(); }, timeoutMs);
    });
    try {
        return await Promise.race([operation(controller.signal), timeout]);
    } finally {
        clearTimeout(timer!);
    }
}
