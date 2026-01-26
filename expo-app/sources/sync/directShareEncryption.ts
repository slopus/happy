import { encodeBase64, decodeBase64 } from '@/encryption/base64';
import { encryptBox } from '@/encryption/libsodium';
import { decodeHex } from '@/encryption/hex';
import sodium from '@/encryption/libsodium.lib';

const CONTENT_KEY_BINDING_PREFIX = new TextEncoder().encode('Happy content key v1\u0000');

export function encryptDataKeyForRecipientV0(
    sessionDataKey: Uint8Array,
    recipientContentPublicKeyB64: string
): string {
    const recipientPublicKey = decodeBase64(recipientContentPublicKeyB64, 'base64');
    const bundle = encryptBox(sessionDataKey, recipientPublicKey);

    const out = new Uint8Array(1 + bundle.length);
    out[0] = 0;
    out.set(bundle, 1);

    return encodeBase64(out, 'base64');
}

export function verifyRecipientContentPublicKeyBinding(params: {
    signingPublicKeyHex: string;
    contentPublicKeyB64: string;
    contentPublicKeySigB64: string;
}): boolean {
    try {
        const signingPublicKey = decodeHex(params.signingPublicKeyHex);
        const contentPublicKey = decodeBase64(params.contentPublicKeyB64, 'base64');
        const sig = decodeBase64(params.contentPublicKeySigB64, 'base64');
        const message = new Uint8Array(CONTENT_KEY_BINDING_PREFIX.length + contentPublicKey.length);
        message.set(CONTENT_KEY_BINDING_PREFIX, 0);
        message.set(contentPublicKey, CONTENT_KEY_BINDING_PREFIX.length);
        return sodium.crypto_sign_verify_detached(sig, message, signingPublicKey);
    } catch {
        return false;
    }
}
