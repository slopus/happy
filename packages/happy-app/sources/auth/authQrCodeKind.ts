import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import sodium from '@/encryption/libsodium.lib';

export type AuthQrCodeKind = 'account' | 'terminal';

const PUBLIC_KEY_VALIDATION_SECRET = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

function isUsableCurve25519PublicKey(publicKey: Uint8Array): boolean {
    try {
        sodium.crypto_box_beforenm(publicKey, PUBLIC_KEY_VALIDATION_SECRET);
        return true;
    } catch {
        return false;
    }
}

function hasValidPublicKey(url: string, prefix: string): boolean {
    if (!url.startsWith(prefix)) {
        return false;
    }

    const encodedKey = url.slice(prefix.length);
    if (!/^[A-Za-z0-9_-]+$/.test(encodedKey)) {
        return false;
    }

    try {
        const publicKey = decodeBase64(encodedKey, 'base64url');
        return publicKey.length === 32
            && encodeBase64(publicKey, 'base64url') === encodedKey
            && isUsableCurve25519PublicKey(publicKey);
    } catch {
        return false;
    }
}

export function getAuthQrCodeKind(url: string): AuthQrCodeKind | null {
    if (hasValidPublicKey(url, 'paws:///account?')) {
        return 'account';
    }

    if (hasValidPublicKey(url, 'paws://terminal?')) {
        return 'terminal';
    }

    return null;
}
