export async function projectFileHash(bytes: Uint8Array): Promise<string> {
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))).map(byte => byte.toString(16).padStart(2, '0')).join('');
}
