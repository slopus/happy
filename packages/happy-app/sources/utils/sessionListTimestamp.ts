/**
 * The corner timestamp on a flat session row, formatted the way a chat list
 * does it: the clock while the day is still yours, the weekday for the week
 * behind you, and a date once the weekday stops naming a single day.
 *
 * The value passed in is the same `lastActivityAt` the list sorts on, so the
 * column reads top to bottom in the order the stamps say it should.
 */
export function formatSessionListTimestamp(timestamp: number, now: number = Date.now()): string {
    const date = new Date(timestamp);
    const days = calendarDaysBetween(date, new Date(now));

    // Anything dated today or ahead of it — a clock skewed a little into the
    // future is still "just now" to the person reading it.
    if (days <= 0) {
        return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    }
    if (days < 7) {
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

/**
 * Whole days between two calendar dates, ignoring the time of day: something
 * from 11pm last night is yesterday at 12:05am, not "0 days ago".
 */
function calendarDaysBetween(from: Date, to: Date): number {
    const fromDay = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
    const toDay = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
    return Math.round((toDay - fromDay) / 86400000);
}
