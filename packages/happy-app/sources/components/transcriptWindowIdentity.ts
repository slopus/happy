import type { ScopedTranscriptItem as DisplayItem } from './continuationTranscript';
import { itemMessages, transcriptRenderKey, type TranscriptReadingAdapter } from './transcriptReading';

type Identity = { key: string; type: DisplayItem['type']; members: Set<string> };
/** Keep only the resident window's wire identities, never its previous payloads.
 * A folded row survives trimming either end of its underlying event window. */
export function reconcileTranscriptIdentities(items: DisplayItem[], adapter: TranscriptReadingAdapter | undefined,
    previous: Identity[] = []) {
    const members = items.map(item => new Set(itemMessages(item).map(message => {
        const id = (item.source?.reading ?? adapter)?.wireId(message.id) ?? message.id;
        return item.source ? JSON.stringify([item.source.sessionId, id]) : id;
    })));
    const matches = items.flatMap((item, index) => item.type === 'message' ? [] : previous
        .filter(row => row.type === item.type).map(row => ({ index, key: row.key,
            overlap: [...members[index]].filter(member => row.members.has(member)).length })))
        .filter(match => match.overlap > 0).sort((a, b) => b.overlap - a.overlap);
    const assigned = new Map<number, string>();
    const reserved = new Set<string>();
    for (const match of matches) {
        if (!assigned.has(match.index) && !reserved.has(match.key)) {
            assigned.set(match.index, match.key); reserved.add(match.key);
        }
    }
    const used = new Set<string>();
    const identities: Identity[] = [];
    const keyed = items.map((item, index) => {
        const ownKey = transcriptRenderKey(item, item.source?.reading ?? adapter);
        let key = assigned.get(index) ?? (item.source ? JSON.stringify([item.source.sessionId, ownKey]) : ownKey);
        if (used.has(key) || (!assigned.has(index) && reserved.has(key))) key = JSON.stringify([key, item.id]);
        used.add(key);
        identities.push({ key, type: item.type, members: members[index] });
        return { ...item, renderKey: key };
    });
    return { keyed, identities };
}
