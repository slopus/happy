import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import type { PendingAttachment } from '@/utils/MessageQueue2';

import type { InputItem } from '../codexAppServerTypes';

export type SupportedImageType = {
    mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
    extension: 'png' | 'jpg' | 'gif' | 'webp';
};

export type PreparedCodexImageInputs = {
    inputItems: InputItem[];
    skipped: number;
};

export function detectSupportedImageType(data: Uint8Array): SupportedImageType | null {
    if (
        data.length >= 8
        && data[0] === 0x89
        && data[1] === 0x50
        && data[2] === 0x4e
        && data[3] === 0x47
        && data[4] === 0x0d
        && data[5] === 0x0a
        && data[6] === 0x1a
        && data[7] === 0x0a
    ) {
        return { mimeType: 'image/png', extension: 'png' };
    }

    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
        return { mimeType: 'image/jpeg', extension: 'jpg' };
    }

    if (data.length >= 6) {
        const header = new TextDecoder().decode(data.slice(0, 6));
        if (header === 'GIF87a' || header === 'GIF89a') {
            return { mimeType: 'image/gif', extension: 'gif' };
        }
    }

    if (
        data.length >= 12
        && data[0] === 0x52
        && data[1] === 0x49
        && data[2] === 0x46
        && data[3] === 0x46
        && data[8] === 0x57
        && data[9] === 0x45
        && data[10] === 0x42
        && data[11] === 0x50
    ) {
        return { mimeType: 'image/webp', extension: 'webp' };
    }

    return null;
}

export function resolveCodexImageCacheDir(opts: {
    sessionId: string;
    cacheRootDir?: string;
}): string {
    return join(opts.cacheRootDir ?? join(configuration.happyHomeDir, 'codex-image-cache'), opts.sessionId);
}

export async function prepareCodexImageInputItems(
    attachments: PendingAttachment[] | undefined,
    opts: {
        sessionId: string;
        cacheRootDir?: string;
    },
): Promise<PreparedCodexImageInputs> {
    if (!attachments || attachments.length === 0) {
        return { inputItems: [], skipped: 0 };
    }

    const cacheDir = resolveCodexImageCacheDir(opts);
    const inputItems: InputItem[] = [];
    let skipped = 0;

    for (const attachment of attachments) {
        const detected = detectSupportedImageType(attachment.data);
        if (!detected) {
            logger.debug('[Codex] Skipping unsupported image attachment', {
                name: attachment.name,
                mimeType: attachment.mimeType,
                size: attachment.data.length,
            });
            skipped += 1;
            continue;
        }

        try {
            await mkdir(cacheDir, { recursive: true });
            const filePath = join(cacheDir, `${randomUUID()}.${detected.extension}`);
            await writeFile(filePath, Buffer.from(attachment.data));
            inputItems.push({ type: 'localImage', path: filePath });
        } catch (error) {
            logger.debug('[Codex] Failed to cache image attachment for localImage input', {
                name: attachment.name,
                mimeType: detected.mimeType,
                size: attachment.data.length,
                errorName: error instanceof Error ? error.name : typeof error,
            });
            skipped += 1;
        }
    }

    return { inputItems, skipped };
}
