import * as hex from '@stablelib/hex';

export function decodeHex(hexString: string, format: 'normal' | 'mac' = 'normal'): Uint8Array {
    if (format === 'mac') {
        const encoded = hexString.replace(/:/g, '');
        return hex.decode(encoded);
    }
    return hex.decode(hexString);
}

export function encodeHex(buffer: Uint8Array, format: 'normal' | 'mac' = 'normal'): string {
    if (format === 'mac') {
        const encoded = hex.encode(buffer);
        return encoded.match(/.{2}/g)?.join(':') || '';
    }
    return hex.encode(buffer);
}