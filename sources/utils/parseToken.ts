import { decodeBase64 } from '@/encryption/base64';

export function parseToken(token: string) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const [_header, payload, _signature] = token.split('.');
    const sub = JSON.parse(new TextDecoder().decode(decodeBase64(payload, 'base64url'))).sub;
    if (typeof sub !== 'string') {
        throw new Error('Invalid token');
    }
    return sub;
}