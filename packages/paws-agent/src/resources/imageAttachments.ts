import nacl from 'tweetnacl';
import { PawsAgentError } from '../client/errors';
import type { ImageAttachmentInput } from '../client/types';
import { deriveKey, getRandomBytes } from '../crypto/encryption';

export function snapshotImages(images: ImageAttachmentInput[] = [], maxImages: 4 | 12 = 4): ImageAttachmentInput[] {
    if (!Array.isArray(images) || images.length > maxImages) {
        throw new PawsAgentError('INVALID_ARGUMENT', `At most ${maxImages} images can be sent`);
    }
    for (const image of images) {
        if (!image || typeof image.name !== 'string' || !image.name.trim()
            || !['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType)
            || !(image.bytes instanceof Uint8Array) || image.bytes.length === 0 || image.bytes.length > 10 * 1024 * 1024
            || [image.width, image.height].some(v => v !== undefined && (!Number.isSafeInteger(v) || v <= 0))
            || ((image.width === undefined) !== (image.height === undefined))) {
            throw new PawsAgentError('INVALID_ARGUMENT', 'Invalid image (PNG/JPEG/WebP, up to 10 MiB with positive dimensions)');
        }
    }
    // 在第一个异步操作前拷贝，防止调用方更改待发送的图片内容。
    return images.map(image => ({ ...image, bytes: new Uint8Array(image.bytes) }));
}

export function encryptImage(bytes: Uint8Array, encryption: { key: Uint8Array; variant: 'legacy' | 'dataKey' }): Uint8Array {
    // Happy Blobs/master/session 是既有持久化协议常量，不能改名。
    const blobKey = deriveKey(encryption.key, 'Happy Blobs', [encryption.variant === 'legacy' ? 'master' : 'session']);
    const nonce = getRandomBytes(nacl.secretbox.nonceLength);
    const cipher = nacl.secretbox(bytes, nonce, blobKey);
    const bundle = new Uint8Array(nonce.length + cipher.length);
    bundle.set(nonce);
    bundle.set(cipher, nonce.length);
    return bundle;
}
