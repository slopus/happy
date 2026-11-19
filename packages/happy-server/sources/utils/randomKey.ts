import * as crypto from 'crypto';
import * as privacyKit from 'privacy-kit';

export function randomKey(prefix: string, length: number = 24): string {
    while (true) {
        const randomBytesBuffer = crypto.randomBytes(length * 2);
        const normalized = privacyKit.encodeBase64(randomBytesBuffer).replace(/[^a-zA-Z0-9]/g, '');
        if (normalized.length < length) {
            continue;
        }
        const base64String = normalized.slice(0, length);
        return `${prefix}_${base64String}`;
    }
}