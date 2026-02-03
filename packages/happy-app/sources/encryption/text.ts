export function encodeUTF8(value: string) {
    return new TextEncoder().encode(value);
}

export function decodeUTF8(value: Uint8Array) {
    return new TextDecoder().decode(value);
}

export function normalizeNFKD(value: string) {
    return value.normalize('NFKD');
}