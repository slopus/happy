/**
 * The corner timestamp on a flat session row, formatted the way a chat list
 * does it: the clock for the last 24 hours, the weekday for the week behind
 * you, and a date once the weekday stops naming a single day. Using elapsed
 * time for the first boundary keeps a Sunday-night session from turning into
 * "Sun" a few minutes after midnight on Monday.
 *
 * The value passed in is the same `lastActivityAt` the list sorts on, so the
 * column reads top to bottom in the order the stamps say it should.
 */
export function formatSessionListTimestamp(timestamp: number, now: number = Date.now()): string {
    const date = new Date(timestamp);
    const age = now - timestamp;
    const dayMs = 24 * 60 * 60 * 1000;

    // A clock skewed a little into the future is still "just now" to the
    // person reading it.
    if (age < dayMs) {
        return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    }
    if (age < 7 * dayMs) {
        return date.toLocaleDateString(undefined, { weekday: 'short' });
    }

    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const thisYear = new Date(now).getFullYear();
    if (date.getFullYear() === thisYear) {
        return `${month}/${day}`;
    }
    return `${month}/${day}/${String(date.getFullYear() % 100).padStart(2, '0')}`;
}
