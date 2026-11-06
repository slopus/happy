/** UTF-8 base64, escaped for embedding directly in a route query. */
export function encodeFilePath(path: string): string {
    const bytes = new TextEncoder().encode(path);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return encodeURIComponent(btoa(binary));
}

/** The router has already decoded the query's percent escapes. */
export function decodeFilePath(value: string): string {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { return binary; } // Older routes encoded Latin-1 filenames directly with btoa.
}
