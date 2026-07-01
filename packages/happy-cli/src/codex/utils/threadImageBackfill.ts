import { readFile } from 'node:fs/promises';

import type { CreateEnvelopeOptions, SessionEnvelope } from '@slopus/happy-wire';
import { createEnvelope } from '@slopus/happy-wire';

import { logger } from '@/ui/logger';

import type { Thread, ThreadItem } from '../codexAppServerTypes';
import { detectSupportedImageType } from './imageInput';
import {
    completedTimestampMs,
    isCodexTurnInProgress,
    mapCodexThreadItemToSessionEnvelopes,
    turnStatus,
    turnTimestampMs,
} from './sessionProtocolMapper';

type LocalImageUpload = (
    attachment: { data: Uint8Array; mimeType: string; name: string },
    opts: Pick<CreateEnvelopeOptions, 'id' | 'time' | 'codexItemId'> & { codexItemId: string },
) => Promise<SessionEnvelope>;

function localImagePaths(item: ThreadItem): string[] {
    if (item.type !== 'userMessage' || !Array.isArray(item.content)) {
        return [];
    }

    return item.content
        .filter((part): part is { type: 'localImage'; path: string } => (
            Boolean(part)
            && typeof part === 'object'
            && (part as { type?: unknown }).type === 'localImage'
            && typeof (part as { path?: unknown }).path === 'string'
            && (part as { path: string }).path.length > 0
        ))
        .map((part) => part.path);
}

async function localImagePathToAttachment(
    path: string,
    index: number,
): Promise<{ data: Uint8Array; mimeType: string; name: string } | null> {
    try {
        const data = new Uint8Array(await readFile(path));
        const detected = detectSupportedImageType(data);
        if (!detected) {
            logger.debug('[Codex image backfill] Skipping unsupported local image input');
            return null;
        }
        return {
            data,
            mimeType: detected.mimeType,
            name: `codex-image-${index}.${detected.extension}`,
        };
    } catch (error) {
        logger.debug('[Codex image backfill] Skipping unavailable local image input', {
            errorName: error instanceof Error ? error.name : typeof error,
        });
        return null;
    }
}

export async function buildCodexThreadBackfillEnvelopes(opts: {
    thread: Pick<Thread, 'turns'>;
    uploadLocalImage: LocalImageUpload;
}): Promise<SessionEnvelope[]> {
    const envelopes: SessionEnvelope[] = [];
    const providerSubagentToSessionSubagent = new Map<string, string>();
    const subagentTitles = new Map<string, string>();
    const collabReceiverThreadIdsByCall = new Map<string, string[]>();
    const collabToolByCall = new Map<string, string>();

    for (const turn of opts.thread.turns ?? []) {
        const startedAt = turnTimestampMs(turn);
        const completedAt = completedTimestampMs(turn);
        const state = {
            currentTurnId: turn.id,
            startedSubagents: new Set<string>(),
            activeSubagents: new Set<string>(),
            providerSubagentToSessionSubagent,
            subagentTitles,
            collabReceiverThreadIdsByCall,
            collabToolByCall,
        };
        envelopes.push(createEnvelope('agent', { t: 'turn-start' }, {
            id: `${turn.id}:start`,
            turn: turn.id,
            time: startedAt,
        }));

        for (const item of turn.items ?? []) {
            const paths = localImagePaths(item);
            for (let index = 0; index < paths.length; index += 1) {
                const attachment = await localImagePathToAttachment(paths[index], index + 1);
                if (!attachment) continue;
                try {
                    envelopes.push(await opts.uploadLocalImage(attachment, {
                        id: `${item.id}:image:${index + 1}`,
                        time: startedAt,
                        codexItemId: item.id,
                    }));
                } catch (error) {
                    logger.debug('[Codex image backfill] Failed to upload local image input', {
                        errorName: error instanceof Error ? error.name : typeof error,
                    });
                }
            }
            envelopes.push(...mapCodexThreadItemToSessionEnvelopes(turn, item, {
                startedAt,
                completedAt,
            }, state));
        }

        if (!isCodexTurnInProgress(turn)) {
            for (const subagent of state.activeSubagents) {
                envelopes.push(createEnvelope('agent', { t: 'stop' }, {
                    turn: turn.id,
                    subagent,
                    time: completedAt,
                }));
            }
            state.activeSubagents.clear();
            state.startedSubagents.clear();
            envelopes.push(createEnvelope('agent', { t: 'turn-end', status: turnStatus(turn) }, {
                id: `${turn.id}:end`,
                turn: turn.id,
                time: completedAt,
            }));
        }
    }

    return envelopes;
}
