import type { PortableContextHead } from '@slopus/happy-wire';

export type NativeCoverageRow = { seq: number; localId?: string | null; content: unknown };
const object = (value: unknown): Record<string, any> | undefined => value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any> : undefined;
function envelope(row: NativeCoverageRow) {
    const raw = object(row.content);
    if (raw?.role !== 'session') return undefined;
    const content = object(raw.content);
    return object(content?.type === 'session' ? content.data : content);
}
function incomingFile(row: NativeCoverageRow) {
    const event = envelope(row);
    if (event?.role === 'user' && event.ev?.t === 'file') return true;
    const raw = object(row.content);
    const file = raw?.role === 'agent' && raw.content?.type === 'event' ? raw.content.data : undefined;
    return file?.type === 'file' && (!file.source || file.source === 'user');
}

/**
 * A completed native turn proves its accepted user localIds, not every message
 * before the current server frontier. Keep a contiguous prefix: uncertain input
 * or any attachment without its own consumption receipt leaves the entire
 * following suffix in the preview. A completed text turn cannot prove download.
 */
export function nativeCoverageFromRows(sessionId: string, throughSeq: number, afterSeq: number, input: NativeCoverageRow[]): PortableContextHead {
    const rows = input.filter(row => row.seq > afterSeq && row.seq <= throughSeq).sort((a, b) => a.seq - b.seq);
    const turns = new Map<string, { localIds: Set<string>; status?: string }>();
    for (const row of rows) {
        const event = envelope(row);
        if (!event || event.subagent || typeof event.turn !== 'string' || event.turn.startsWith('codex-command-') || event.role === 'user') continue;
        const turn = turns.get(event.turn) ?? { localIds: new Set<string>() };
        if (event.ev?.t === 'turn-start' && Array.isArray(event.ev.localIds)) {
            for (const id of event.ev.localIds) if (typeof id === 'string' && id) turn.localIds.add(id);
        }
        if (event.ev?.t === 'turn-end') turn.status = event.ev.status;
        turns.set(event.turn, turn);
    }
    const accepted = new Set([...turns.values()].filter(turn => turn.status === 'completed').flatMap(turn => [...turn.localIds]));
    let covered = afterSeq;
    for (const row of rows) {
        const raw = object(row.content);
        if (!raw || !['user', 'agent', 'session'].includes(raw.role)) break;
        if (incomingFile(row)) {
            return { sessionId, throughSeq: Math.max(afterSeq, row.seq - 1), afterSeq };
        } else if (raw.role === 'user') {
            const text = typeof raw.meta?.displayText === 'string' ? raw.meta.displayText : raw.content?.text;
            if (typeof text !== 'string' || text.trimStart().startsWith('/') || !row.localId || !accepted.has(row.localId)) {
                return { sessionId, throughSeq: Math.max(afterSeq, row.seq - 1), afterSeq };
            }
        }
        covered = row.seq;
    }
    return { sessionId, throughSeq: covered, afterSeq };
}

/** Single traversal of immutable pages, never status polling or optimistic UI. */
export async function readNativeConversationCoverage(options: {
    sessionId: string; throughSeq: number; afterSeq: number;
    readPage: (afterSeq: number) => Promise<{ messages: NativeCoverageRow[]; hasMore: boolean }>;
}): Promise<PortableContextHead> {
    const rows: NativeCoverageRow[] = [];
    let cursor = options.afterSeq;
    for (;;) {
        const page = await options.readPage(cursor);
        if (!Array.isArray(page.messages) || typeof page.hasMore !== 'boolean') throw new Error('Native input coverage history is unavailable.');
        const next = Math.max(cursor, ...page.messages.map(row => row.seq));
        if (page.messages.some(row => !Number.isSafeInteger(row.seq) || row.seq <= cursor || !row.content)
            || (page.hasMore && next <= cursor)) throw new Error('Native input coverage history did not advance.');
        let expected = cursor + 1;
        for (const row of [...page.messages].sort((a, b) => a.seq - b.seq)) {
            if (row.seq > options.throughSeq) break;
            if (row.seq !== expected++) throw new Error('Native input coverage history is incomplete.');
        }
        rows.push(...page.messages.filter(row => row.seq <= options.throughSeq));
        if (!page.hasMore || next >= options.throughSeq) break;
        cursor = next;
    }
    return nativeCoverageFromRows(options.sessionId, options.throughSeq, options.afterSeq, rows);
}
