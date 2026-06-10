import type { ApiSessionClient } from '@/api/apiSession';
import type { FileEventMessage } from '@/api/types';
import { logger } from '@/ui/logger';
import type { PendingAttachment } from '@/utils/MessageQueue2';

type CodexAttachmentDownloader = Pick<ApiSessionClient, 'downloadAndDecryptAttachment'>;

export async function downloadCodexFileEventAttachment(
    session: CodexAttachmentDownloader,
    fileEvent: FileEventMessage,
): Promise<PendingAttachment | null> {
    const ev = fileEvent.content.data.ev;
    try {
        const decrypted = await session.downloadAndDecryptAttachment(ev.ref);
        if (!decrypted) {
            logger.debug(`[Codex] Failed to decrypt attachment: ${ev.name}`);
            return null;
        }
        return {
            data: decrypted,
            mimeType: ev.mimeType ?? 'image/jpeg',
            name: ev.name,
        };
    } catch (error) {
        logger.debug(`[Codex] Failed to download attachment: ${ev.name}`, { error });
        return null;
    }
}
