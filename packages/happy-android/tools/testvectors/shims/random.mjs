// A scripted random source. Tests queue the exact bytes the next calls must
// return, so the TypeScript output is reproducible from the vector file.
const queue = [];

export function scriptRandom(...chunks) {
    queue.push(...chunks.map((chunk) => Uint8Array.from(chunk)));
}

export function assertRandomDrained() {
    if (queue.length !== 0) throw new Error(`${queue.length} scripted random chunk(s) unused`);
}

export function nextRandom(size) {
    const chunk = queue.shift();
    if (!chunk) throw new Error(`Unscripted random request for ${size} bytes`);
    if (chunk.length !== size) throw new Error(`Scripted ${chunk.length} random bytes, ${size} requested`);
    return Uint8Array.from(chunk);
}
