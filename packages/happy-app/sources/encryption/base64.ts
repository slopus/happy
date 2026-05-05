export function decodeBase64(base64: string, encoding: 'base64' | 'base64url' = 'base64'): Uint8Array {
    let normalizedBase64 = base64;
    
    if (encoding === 'base64url') {
        normalizedBase64 = base64
            .replace(/-/g, '+')
            .replace(/_/g, '/');
        
        const padding = normalizedBase64.length % 4;
        if (padding) {
            normalizedBase64 += '='.repeat(4 - padding);
        }
    }
    
    const binaryString = atob(normalizedBase64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    
    return bytes;
}

export function encodeBase64(buffer: Uint8Array, encoding: 'base64' | 'base64url' = 'base64'): string {
    // Chunk the conversion to avoid `Maximum call stack size exceeded` on
    // buffers larger than ~64KB on web (String.fromCharCode.apply blows up).
    // 0x8000 keeps each apply call within engine limits across browsers.
    const CHUNK = 0x8000;
    let binaryString = '';
    for (let i = 0; i < buffer.length; i += CHUNK) {
        const chunk = buffer.subarray(i, i + CHUNK);
        binaryString += String.fromCharCode.apply(null, chunk as unknown as number[]);
    }
    const base64 = btoa(binaryString);

    if (encoding === 'base64url') {
        return base64
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=/g, '');
    }

    return base64;
}