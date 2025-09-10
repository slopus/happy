import { fromByteArray, toByteArray } from 'react-native-quick-base64';

export function decodeBase64(base64: string, encoding: 'base64' | 'base64url' = 'base64'): Uint8Array {
    if (encoding === 'base64url') {
        return toByteArray(base64, true);
    }
    return toByteArray(base64, true);
}

export function encodeBase64(buffer: Uint8Array, encoding: 'base64' | 'base64url' = 'base64'): string {
    return fromByteArray(buffer, encoding === 'base64url');
}