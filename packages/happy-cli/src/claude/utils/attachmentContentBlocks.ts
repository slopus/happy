/**
 * Converts decrypted attachments into Claude API content blocks.
 *
 * Routing, in priority order on the decrypted BYTES (wire mimeType is
 * advisory only — iOS pickers lie):
 *   1. JPEG/PNG/GIF/WebP magic  -> image block
 *   2. %PDF- magic              -> document block (application/pdf)
 *   3. text/* mime, known text extension, or clean UTF-8 decode -> fenced text block
 *   4. anything else           -> visible notice appended to the text message
 *      (previously these were dropped with only a debug log)
 */
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';

export type PendingAttachmentLike = { data: Uint8Array; mimeType: string; name: string };

/**
 * Detect the image media type Claude accepts from the decrypted blob's
 * magic-byte header. The wire-supplied mimeType is unreliable (iOS picker
 * reports things like "image/heic" or no value at all), and the Anthropic
 * API enforces a strict enum on `image.source.base64.media_type`. Returning
 * null when the bytes don't match a supported format causes the caller to
 * drop the attachment instead of shipping an invalid request that the API
 * rejects with HTTP 400.
 */
export function detectClaudeImageMime(bytes: Uint8Array): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | null {
    if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
        return 'image/png';
    }
    if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
        return 'image/jpeg';
    }
    if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
        return 'image/gif';
    }
    if (
        bytes.length >= 12 &&
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) {
        return 'image/webp';
    }
    return null;
}

function isPdf(bytes: Uint8Array): boolean {
    return bytes.length >= 5 &&
        bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2D;
}

const TEXT_EXTENSIONS = new Set([
    'txt', 'md', 'log', 'json', 'yaml', 'yml', 'csv', 'xml', 'html', 'css',
    'js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp',
    'sh', 'toml', 'ini', 'cfg', 'conf', 'sql', 'swift', 'kt', 'env',
]);

function decodeAsText(att: PendingAttachmentLike): string | null {
    const ext = att.name.includes('.') ? att.name.split('.').pop()!.toLowerCase() : '';
    const looksTextual = att.mimeType.startsWith('text/') || TEXT_EXTENSIONS.has(ext);
    try {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(att.data);
        // Reject decodes full of control chars even if technically valid UTF-8,
        // unless mime/extension already vouches for it.
        if (!looksTextual && /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(decoded)) return null;
        return decoded;
    } catch {
        return null;
    }
}

export function attachmentsToContentBlocks(
    attachments: PendingAttachmentLike[],
    messageText: string,
): ContentBlockParam[] {
    const blocks: ContentBlockParam[] = [];
    const unsupported: string[] = [];

    for (const att of attachments) {
        const imageMime = detectClaudeImageMime(att.data);
        if (imageMime) {
            blocks.push({
                type: 'image',
                source: { type: 'base64', media_type: imageMime, data: Buffer.from(att.data).toString('base64') },
            });
            continue;
        }
        if (isPdf(att.data)) {
            blocks.push({
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(att.data).toString('base64') },
            });
            continue;
        }
        const text = decodeAsText(att);
        if (text !== null) {
            blocks.push({ type: 'text', text: `Attached file "${att.name}":\n\`\`\`\n${text}\n\`\`\`` });
            continue;
        }
        unsupported.push(att.name);
    }

    let tail = messageText;
    if (unsupported.length > 0) {
        tail += `\n\n[Note: attachment(s) ${unsupported.map(n => `"${n}"`).join(', ')} were not a supported type and were omitted.]`;
    }
    blocks.push({ type: 'text', text: tail });
    return blocks;
}
