import { describe, expect, it } from 'vitest';

import { formatSessionListTimestamp } from './sessionListTimestamp';

const now = new Date(2026, 7, 23, 14, 30).getTime(); // Sunday 23 Aug 2026

describe('formatSessionListTimestamp', () => {
    it('shows the clock for anything less than 24 hours old', () => {
        const morning = new Date(2026, 7, 23, 9, 5).getTime();
        expect(formatSessionListTimestamp(morning, now)).toBe(
            new Date(morning).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
        );

        // Crossing midnight should not turn a minutes-old clock into "Sun".
        const monday = new Date(2026, 7, 24, 0, 5).getTime();
        const sundayNight = new Date(2026, 7, 23, 23, 58).getTime();
        expect(formatSessionListTimestamp(sundayNight, monday)).toBe(
            new Date(sundayNight).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
        );

        expect(formatSessionListTimestamp(now + 60_000, now)).toMatch(/\d/);
    });

    it('shows the weekday from 24 hours through the following week', () => {
        const yesterdayMorning = new Date(2026, 7, 22, 9, 5).getTime();
        expect(formatSessionListTimestamp(yesterdayMorning, now)).toBe(
            new Date(yesterdayMorning).toLocaleDateString(undefined, { weekday: 'short' }),
        );
        const sixDaysAgo = new Date(2026, 7, 17, 8, 0).getTime();
        expect(formatSessionListTimestamp(sixDaysAgo, now)).toBe(
            new Date(sixDaysAgo).toLocaleDateString(undefined, { weekday: 'short' }),
        );
    });

    it('shows a short date once a weekday would be ambiguous', () => {
        expect(formatSessionListTimestamp(new Date(2026, 7, 16, 8, 0).getTime(), now)).toBe('08/16');
        expect(formatSessionListTimestamp(new Date(2026, 0, 3, 8, 0).getTime(), now)).toBe('01/03');
    });

    it('adds the year once the date leaves this one', () => {
        expect(formatSessionListTimestamp(new Date(2025, 10, 4, 8, 0).getTime(), now)).toBe('11/04/25');
    });
});
