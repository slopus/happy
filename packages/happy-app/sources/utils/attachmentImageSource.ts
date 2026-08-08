import { encodeBase64 } from '@/encryption/base64';
import type { AttachmentImageSourceOptions, LoadedAttachmentImageSource } from './attachmentImageSourceTypes';

export async function createAttachmentImageSource(
    bytes: Uint8Array,
    mime: string,
    _options: AttachmentImageSourceOptions = {},
): Promise<LoadedAttachmentImageSource> {
    return {
        uri: `data:${mime};base64,${encodeBase64(bytes)}`,
        byteSize: bytes.byteLength,
        dispose: () => {},
    };
}
