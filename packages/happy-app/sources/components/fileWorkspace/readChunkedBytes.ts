type Chunk = { success: boolean; content?: string; offset?: number; totalSize?: number; revision?: string; error?: string };
/** Fetch consecutive byte ranges, never retry or query business state. */
export async function readChunkedBytes(read: (offset: number, length: number, revision?: string) => Promise<Chunk>, signal?: AbortSignal): Promise<Uint8Array> {
    const chunkSize = 256 * 1024, limit = 10 * 1024 * 1024;
    let output: Uint8Array | undefined, offset = 0, revision: string | undefined;
    do {
        if (signal?.aborted) throw new Error('Read aborted');
        const chunk = await read(offset, chunkSize, revision);
        if (signal?.aborted) throw new Error('Read aborted');
        if (!chunk.success || typeof chunk.content !== 'string' || chunk.offset !== offset || !Number.isSafeInteger(chunk.totalSize) || chunk.totalSize! < 0 || chunk.totalSize! > limit || typeof chunk.revision !== 'string' || !chunk.revision || chunk.content.length > Math.ceil(chunkSize / 3) * 4 + 4) throw new Error(chunk.error || 'Invalid media range');
        if (!output) { output = new Uint8Array(chunk.totalSize!); revision = chunk.revision; }
        if (chunk.totalSize !== output.length || chunk.revision !== revision) throw new Error('File changed during read');
        const binary = atob(chunk.content);
        const expected = Math.min(chunkSize, output.length - offset);
        if (binary.length !== expected) throw new Error('Incomplete media range');
        for (let index = 0; index < binary.length; index++) output[offset + index] = binary.charCodeAt(index);
        offset += binary.length;
    } while (offset < output.length);
    return output;
}
