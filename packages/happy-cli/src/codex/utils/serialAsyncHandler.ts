export function createSerialAsyncHandler<T>(
    handler: (value: T) => Promise<void>,
    onError?: (error: unknown) => void,
): (value: T) => void {
    let tail = Promise.resolve();

    return (value: T) => {
        tail = tail
            .then(() => handler(value))
            .catch((error) => {
                onError?.(error);
            });
    };
}
