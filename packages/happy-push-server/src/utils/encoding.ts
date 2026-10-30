const textEncoder = new TextEncoder();

export function utf8(value: string): Uint8Array {
    return textEncoder.encode(value);
}

export function utf8Length(value: string): number {
    return textEncoder.encode(value).byteLength;
}

export function base64UrlEncode(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlEncodeJson(value: unknown): string {
    return base64UrlEncode(utf8(JSON.stringify(value)));
}

export function base64Decode(value: string): Uint8Array {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

/**
 * Decodes a PEM block to DER. Accepts keys pasted into a secret with literal
 * "\n" sequences instead of newlines, which is how they often arrive from JSON
 * or a single-line env var.
 */
export function pemToDer(pem: string): Uint8Array {
    const body = pem
        .replace(/\\n/g, '\n')
        .replace(/-----BEGIN [^-]+-----/g, '')
        .replace(/-----END [^-]+-----/g, '')
        .replace(/\s+/g, '');
    if (body.length === 0) {
        throw new Error('PEM contains no key data');
    }
    return base64Decode(body);
}
