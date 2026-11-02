import type { ContentBlockParam, MessageParam } from '@anthropic-ai/sdk/resources';

import { logger } from '@/ui/logger';
import { detectSupportedImageType, formatAttachmentNote, saveAttachmentFiles } from '@/utils/attachmentFiles';
import type { PendingAttachment } from '@/utils/MessageQueue2';

/**
 * The user turn for a message that carried attachments. Normally the
 * attachments are saved as files and the turn names their paths, so Claude
 * reads a picture with Read only if it needs it. When Read is unavailable
 * (`canReadFiles` false) a path is useless, and the pictures go inline as
 * before.
 *
 * Always a block array, never a string: the remote session scanner forwards
 * string prompts it finds in the transcript that the app did not send, and
 * the text Claude receives here differs from the text the app sent.
 */
export async function buildClaudeAttachmentContent(opts: {
    text: string;
    attachments: PendingAttachment[];
    sessionId: string;
    canReadFiles: boolean;
    rootDir?: string;
}): Promise<MessageParam['content']> {
    const blocks: ContentBlockParam[] = [];
    if (!opts.canReadFiles) {
        for (const attachment of opts.attachments) {
            // Detect media type from the decrypted bytes' magic header rather
            // than trusting the wire-supplied mimeType: iOS pickers report
            // things like "image/heic" or nothing, and the Anthropic API
            // rejects anything outside its four formats.
            const detected = detectSupportedImageType(attachment.data);
            if (!detected) {
                logger.debug(`[remote] Skipping unsupported attachment (no magic-byte match), claimed mimeType=${attachment.mimeType}`);
                continue;
            }
            blocks.push({
                type: 'image',
                source: {
                    type: 'base64',
                    media_type: detected.mimeType,
                    data: Buffer.from(attachment.data).toString('base64'),
                },
            });
        }
        if (opts.text.length > 0 || blocks.length === 0) {
            blocks.push({ type: 'text', text: opts.text });
        }
        return blocks;
    }

    const saved = await saveAttachmentFiles(opts.attachments, { sessionId: opts.sessionId, rootDir: opts.rootDir });
    const note = formatAttachmentNote(saved);
    if (opts.text.length > 0 || !note) {
        blocks.push({ type: 'text', text: opts.text });
    }
    if (note) {
        blocks.push({ type: 'text', text: note });
    }
    return blocks;
}

/**
 * Whether Claude has a tool that opens a saved attachment. Only a bare
 * `Read` removes the tool; `Read(./secrets/**)` restricts some paths.
 */
export function claudeCanReadFiles(disallowedTools: string[] | undefined): boolean {
    return !(disallowedTools ?? []).includes('Read');
}
