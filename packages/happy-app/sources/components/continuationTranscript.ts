import { groupMessagesForDisplay, type DisplayItem } from '@/hooks/useGroupedMessages';
import type { Metadata } from '@/sync/storageTypes';
import type { Message } from '@/sync/typesMessage';
import { getBrowserStepRuns, hideLinkedBrowserSteps } from './rightPanel/browserStepRunsModel';
import type { TranscriptReadingAdapter } from './transcriptReading';

export type ContinuationSection = { id: string; metadata: Metadata | null; messages: Message[]; reading?: TranscriptReadingAdapter };
export type ScopedTranscriptItem = DisplayItem & {
    source?: { sessionId: string; metadata: Metadata | null; readOnly: boolean; reading?: TranscriptReadingAdapter; browserRuns?: ReturnType<typeof getBrowserStepRuns> };
    continuationBoundary?: boolean;
    continuationWaiting?: boolean;
};

/** Newest-first, keeping provider identities and grouping inside each session. */
export function composeContinuationItems(sections: ContinuationSection[], currentId: string,
    groupTools: boolean, currentTurnActive: boolean): ScopedTranscriptItem[] {
    return sections.flatMap(section => {
        const browserRuns = getBrowserStepRuns(section.messages);
        const source = { sessionId: section.id, metadata: section.metadata, readOnly: section.id !== currentId, reading: section.reading, browserRuns };
        const items: ScopedTranscriptItem[] = groupMessagesForDisplay(hideLinkedBrowserSteps(section.messages, browserRuns), groupTools,
            { currentTurnActive: !source.readOnly && currentTurnActive }).map(item => ({
                ...item, id: JSON.stringify([section.id, item.id]), source,
            }));
        if (section.metadata?.continuationOfSessionId) {
            const id = JSON.stringify([section.id, 'continuation-boundary']);
            items.push({ type: 'message', id, source, continuationBoundary: true, continuationWaiting: section.messages.length === 0,
                message: { kind: 'agent-text', id, localId: null, createdAt: 0, text: '' } });
        }
        return items;
    });
}

/** Never join a newer section across an unloaded tail of an older session. */
export function visibleContinuationIds(ids: string[], windows: Record<string, { hasMoreNewer?: boolean } | undefined>): string[] {
    let start = 0;
    ids.forEach((id, index) => { if (windows[id]?.hasMoreNewer) start = index; });
    return ids.slice(start);
}
