/**
 * Convert decrypted image attachments from the mobile/web client into Codex
 * app-server `localImage` input items.
 *
 * The Codex app-server protocol accepts image input as `{ type: 'localImage';
 * path }` — it reads the file from disk at turn time. So unlike the Claude path
 * (which base64-inlines the bytes into the SDK request), here we must persist
 * each attachment to a real file on disk and hand Codex its path.
 *
 * We stage the bytes into `configuration.attachmentsDir` (the same persistent
 * staging dir the Claude path archives originals into) and keep the file around
 * for the duration of the turn — Codex needs it readable while it processes the
 * turn, so we deliberately do NOT delete it here.
 *
 * The wire-supplied mimeType is unreliable (iOS pickers report "image/heic" or
 * nothing), so we sniff the magic-byte header and only emit items for the four
 * formats GPT vision accepts (png/jpeg/gif/webp); anything else is dropped with
 * a debug log rather than handed to Codex as a file it can't decode.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { isMediaAttachment, type PendingAttachment } from '@/utils/MessageQueue2';
import { formatMediaAttachmentNotice } from '@/api/mediaAttachment';
import type { InputItem } from './codexAppServerTypes';

type DetectedImage = { mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; ext: 'png' | 'jpg' | 'gif' | 'webp' };

/**
 * Sniff the image media type from the decrypted blob's magic-byte header.
 * Returns null when the bytes don't match a format GPT vision accepts, which
 * tells the caller to drop the attachment instead of shipping Codex a file it
 * can't read.
 */
export function detectCodexImage(bytes: Uint8Array): DetectedImage | null {
    if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
        return { mime: 'image/png', ext: 'png' };
    }
    if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
        return { mime: 'image/jpeg', ext: 'jpg' };
    }
    if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
        return { mime: 'image/gif', ext: 'gif' };
    }
    if (
        bytes.length >= 12 &&
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) {
        return { mime: 'image/webp', ext: 'webp' };
    }
    return null;
}

/**
 * Stage each supported image attachment to disk and return the corresponding
 * Codex `localImage` input items. Unsupported or unwritable attachments are
 * skipped (logged), never throwing — a bad attachment must not sink the turn.
 *
 * `stampSeed` lets tests pass a deterministic timestamp; production callers
 * omit it and get a fresh ISO stamp per call.
 */
export function materializeCodexImageItems(
    attachments: PendingAttachment[],
    stampSeed?: string,
): Array<{ type: 'localImage'; path: string }> {
    const items: Array<{ type: 'localImage'; path: string }> = [];
    attachments.forEach((att, index) => {
        if (isMediaAttachment(att)) {
            return; // audio/video handled as a text notice, not a localImage
        }
        const detected = detectCodexImage(att.data);
        if (!detected) {
            logger.debug(`[codex] Skipping unsupported attachment (no magic-byte match): ${att.name}, claimed mimeType=${att.mimeType}`);
            return;
        }
        const stamp = (stampSeed ?? new Date().toISOString()).replace(/[:.]/g, '-');
        const baseName = (att.name || 'attachment').replace(/\.[^.]+$/, '').replace(/[^\w.\-]+/g, '_');
        const fileName = `${stamp}-${index}-${baseName || 'image'}.${detected.ext}`;
        const path = join(configuration.attachmentsDir, fileName);
        try {
            writeFileSync(path, att.data);
            logger.debug(`[codex] Staged image attachment to ${path} (${att.data.length} bytes, ${detected.mime})`);
            items.push({ type: 'localImage', path });
        } catch (e) {
            logger.debug(`[codex] Failed to stage attachment ${att.name}: ${e}`);
        }
    });
    return items;
}

/** Build the full Codex input array: staged images first, then the text
 *  (with any audio/video local-path notice prepended to the user prompt). */
export function buildCodexInput(
    prompt: string,
    attachments: PendingAttachment[] | undefined,
): InputItem[] {
    const images = attachments && attachments.length > 0 ? materializeCodexImageItems(attachments) : [];
    const mediaNotice = formatMediaAttachmentNotice((attachments ?? []).filter(isMediaAttachment));
    const text = mediaNotice ? `${mediaNotice}\n\n${prompt}` : prompt;
    return [...images, { type: 'text', text }];
}

export function buildCodexImageAttachmentNotice(
    images: Array<{ type: 'localImage'; path: string }>,
): string | null {
    if (images.length === 0) return null;

    const imageList = images
        .map((image, index) => `- Image ${index + 1}: ${image.path}`)
        .join('\n');

    return [
        `Happy attached ${images.length} user-uploaded image${images.length === 1 ? '' : 's'} to this Codex turn.`,
        'Use these exact localImage paths as the visual reference for the user request.',
        'Do not infer the intended upload by scanning ~/.happy/attachments, sorting recent files, or choosing files from previous turns.',
        imageList,
    ].join('\n');
}

/**
 * Assemble the exact payload consumed by Codex app-server.
 *
 * Keeping the text and image extraction together prevents callers from
 * accidentally discarding the media-path notice added by buildCodexInput.
 */
export function buildCodexTurnPayload(
    prompt: string,
    attachments: PendingAttachment[] | undefined,
): {
    prompt: string;
    images: Array<{ type: 'localImage'; path: string }>;
} {
    const input = buildCodexInput(prompt, attachments);
    const images = input.filter(
        (item): item is { type: 'localImage'; path: string } => item.type === 'localImage',
    );
    const text = input.find((item): item is { type: 'text'; text: string } => item.type === 'text')?.text ?? prompt;
    const imageNotice = buildCodexImageAttachmentNotice(images);

    return {
        prompt: imageNotice ? `${imageNotice}\n\n${text}` : text,
        images,
    };
}
