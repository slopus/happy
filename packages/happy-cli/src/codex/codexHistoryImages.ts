import { basename } from 'node:path';
import type { SessionEnvelope } from '@slopus/happy-wire';
import type { ApiSessionClient } from '@/api/apiSession';
import type { Thread, InputItem } from './codexAppServerTypes';
import { readPawsTurnOrigin } from './codexPrompt';
import { mapCodexThreadToSessionEnvelopes } from './utils/sessionProtocolMapper';

export type HistoryImageSession = Partial<Pick<ApiSessionClient, 'uploadImageAttachment'>>;
type HistoryOptions = Omit<NonNullable<Parameters<typeof mapCodexThreadToSessionEnvelopes>[1]>, 'historicalUserImages'>;

/** Native history references local files, while Happy attachments are encrypted
 * for one session. Upload into the destination before acknowledging the replay. */
export async function mapCodexHistoryWithImages(
    thread: Pick<Thread, 'turns'>,
    session: HistoryImageSession,
    options: HistoryOptions = {},
): Promise<SessionEnvelope[]> {
    const imagesByItem = new Map<string, SessionEnvelope['ev'][]>();
    const uploaded = new Map<string, SessionEnvelope['ev']>();
    for (const turn of thread.turns ?? []) {
        for (const item of turn.items ?? []) {
            if (item.type !== 'userMessage') continue;
            const content: InputItem[] = Array.isArray(item.content) ? item.content : [];
            const text = content.filter(input => input.type === 'text').map(input => input.text).join('\n');
            if (options.omitPawsUserMessagesFromOriginToken
                && readPawsTurnOrigin(text) === options.omitPawsUserMessagesFromOriginToken) continue;
            const events: SessionEnvelope['ev'][] = [];
            for (const input of content) {
                if (input.type !== 'localImage') continue;
                let event = uploaded.get(input.path);
                if (!event) {
                    if (!session.uploadImageAttachment) throw new Error('Historical image upload is unavailable');
                    try {
                        const attachment = await session.uploadImageAttachment(input.path);
                        event = {
                            t: 'file', ref: attachment.ref, name: attachment.name, size: attachment.size,
                            source: 'user', encrypted: true,
                            ...(attachment.dims ? { image: { ...attachment.dims, thumbhash: '' } } : {}),
                            ...(attachment.motionPhoto ? { motionPhoto: attachment.motionPhoto } : {}),
                        };
                    } catch (error) {
                        // An expired local attachment cannot be recovered, but must
                        // not silently disappear. Transient upload errors still fail
                        // the replay so the durable marker can drive a retry.
                        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
                        event = { t: 'text', text: `[Historical image unavailable: ${basename(input.path)}]` };
                    }
                    uploaded.set(input.path, event);
                }
                events.push(event);
            }
            imagesByItem.set(JSON.stringify([turn.id, item.id]), events);
        }
    }
    return mapCodexThreadToSessionEnvelopes(thread, {
        ...options,
        historicalUserImages: (turnId, itemId) => imagesByItem.get(JSON.stringify([turnId, itemId])) ?? [],
    });
}
