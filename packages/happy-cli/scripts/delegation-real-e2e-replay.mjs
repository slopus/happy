import assert from 'node:assert/strict';

/**
 * A v3 batch broadcasts only its newest row. A notice therefore advances a
 * durable cursor, rather than standing in for every native protocol envelope.
 * Reads are event-triggered, bounded pages with mandatory forward progress.
 * No periodic query, retry timer, or model submission is performed here.
 */
export function createEventDrivenMessageReplay({ sessionId, afterSeq = 0, pageSize = 500, readPage, onMessage, onError }) {
    assert(typeof sessionId === 'string' && sessionId.length, 'An exact replay session is required');
    assert(Number.isSafeInteger(afterSeq) && afterSeq >= 0, 'Invalid replay cursor');
    assert(Number.isSafeInteger(pageSize) && pageSize >= 1 && pageSize <= 500, 'Replay pages must be bounded');
    let cursor = afterSeq;
    let announced = afterSeq;
    let active;
    let stopped = false;
    const notifiedRows = new Map();

    const deliver = async row => {
        if (stopped || row.seq <= cursor) return;
        await onMessage(row);
        cursor = row.seq;
        for (const seq of notifiedRows.keys()) if (seq <= cursor) notifiedRows.delete(seq);
    };
    const drain = async () => {
        // Pagination terminates at the highest real notification (or a newer
        // durable row in that page). Every iteration must advance the cursor.
        while (!stopped && cursor < announced) {
            const contiguous = notifiedRows.get(cursor + 1);
            if (contiguous) { await deliver(contiguous); continue; }
            const before = cursor;
            const requestedThrough = announced;
            const page = await readPage({ sessionId, afterSeq: cursor, limit: pageSize });
            if (stopped) return;
            assert(Array.isArray(page?.messages) && page.messages.length <= pageSize, 'Invalid bounded durable message page');
            let last = before;
            for (const row of page.messages) {
                assert(Number.isSafeInteger(row?.seq) && row.seq > last, 'Durable replay rows must be ordered after the requested cursor');
                last = row.seq;
                await deliver(row);
                if (stopped) return;
            }
            assert(cursor > before, 'The notified durable message was absent; automatic query retries are disabled');
            assert(cursor >= requestedThrough || page.hasMore === true, 'The notified durable message was absent; automatic query retries are disabled');
        }
    };
    const start = () => {
        if (active || stopped || cursor >= announced) return active ?? Promise.resolve();
        active = drain().catch(error => {
            if (stopped) return;
            stopped = true;
            notifiedRows.clear();
            onError(error);
        }).finally(() => {
            active = undefined;
            // A new notice can arrive as the preceding drain is settling.
            if (!stopped && cursor < announced) return start();
        });
        return active;
    };
    return {
        notify(notifiedSessionId, row) {
            if (stopped || notifiedSessionId !== sessionId) return Promise.resolve();
            if (!Number.isSafeInteger(row?.seq) || row.seq <= 0) {
                stopped = true;
                notifiedRows.clear();
                onError(new Error('The scoped durable notification has an invalid sequence'));
                return Promise.resolve();
            }
            if (row.seq <= cursor) return active ?? Promise.resolve();
            announced = Math.max(announced, row.seq);
            notifiedRows.set(row.seq, row);
            return start();
        },
        stop() { stopped = true; notifiedRows.clear(); },
    };
}
