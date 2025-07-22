import * as b64 from '@stablelib/base64';

export function decodeBase64(base64: string, encoding: 'base64' | 'base64url' = 'base64'): Uint8Array {
    if (encoding === 'base64url') {
        return b64.decodeURLSafe(base64);
    }
    return b64.decode(base64);
}

export function encodeBase64(buffer: Uint8Array, encoding: 'base64' | 'base64url' = 'base64'): string {
    if (encoding === 'base64url') {
        return b64.encodeURLSafe(buffer);
    }
    return b64.encode(buffer);
}