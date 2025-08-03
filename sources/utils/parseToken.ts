import { decodeBase64 } from "@/auth/base64";
import { decodeUTF8, encodeUTF8 } from "@/encryption/text";

export function parseToken(token: string) {
    const [header, payload, signature] = token.split('.');
    const sub = JSON.parse(decodeUTF8(decodeBase64(payload))).sub;
    if (typeof sub !== 'string') {
        throw new Error('Invalid token');
    }
    return sub;
}