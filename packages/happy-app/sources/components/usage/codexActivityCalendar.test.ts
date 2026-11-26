import { describe, expect, it } from 'vitest';
import {
    buildActivityCalendar,
    formatActivityTokens,
    getActivityLevel,
    type ActivityDay,
    type ActivitySnapshot,
} from './codexActivityCalendar';

function snapshot(at: string, days: ActivityDay[] = [], timeZone = 'Asia/Shanghai'): ActivitySnapshot {
    return { source: 'codex-session-jsonl', scannedAt: Date.parse(at), timeZone, days };
}

function day(date: string, inputTokens: number, cachedInputTokens = 0, outputTokens = 0): ActivityDay {
    return {
        date,
        inputTokens,
        cachedInputTokens,
        outputTokens,
        reasoningOutputTokens: 0,
        totalTokens: inputTokens + outputTokens,
        tokenCountEvents: 1,
        sessions: 1,
        totalOnlyTokens: 0,
    };
}

describe('buildActivityCalendar', () => {
    it('fills exactly 365 consecutive days through Shanghai midnight across a year boundary', () => {
        const before = buildActivityCalendar(snapshot('2025-12-31T15:59:59.999Z'));
        const after = buildActivityCalendar(snapshot('2025-12-31T16:00:00.000Z'));
        expect(before.from).toBe('2025-01-01');
        expect(before.to).toBe('2025-12-31');
        expect(after.from).toBe('2025-01-02');
        expect(after.to).toBe('2026-01-01');
        expect(after.days).toHaveLength(365);
        expect(new Set(after.days.map(value => value.date)).size).toBe(365);
        after.days.forEach((value, index) => {
            if (index > 0) {
                expect(Date.parse(value.date) - Date.parse(after.days[index - 1].date)).toBe(86_400_000);
            }
        });
    });

    it('uses a rolling 365-day window including leap day, rather than one calendar year', () => {
        const calendar = buildActivityCalendar(snapshot('2024-03-01T04:00:00Z'));
        expect(calendar.days).toHaveLength(365);
        expect(calendar.from).toBe('2023-03-03');
        expect(calendar.days.slice(-3).map(value => value.date)).toEqual(['2024-02-28', '2024-02-29', '2024-03-01']);
    });

    it('keeps date arithmetic continuous over daylight-saving changes and respects the host timezone', () => {
        const timestamp = '2026-03-09T03:30:00Z';
        const newYork = buildActivityCalendar(snapshot(timestamp, [], 'America/New_York'));
        const utc = buildActivityCalendar(snapshot(timestamp, [], 'UTC'));
        expect(newYork.to).toBe('2026-03-08');
        expect(utc.to).toBe('2026-03-09');
        expect(newYork.days.slice(-3).map(value => value.date)).toEqual(['2026-03-06', '2026-03-07', '2026-03-08']);
    });

    it('excludes stale and future records and counts cached input and reasoning output only once', () => {
        const today = { ...day('2026-11-26', 1_200, 1_100, 300), reasoningOutputTokens: 200 };
        const yesterday = day('2026-11-25', 100, 20, 50);
        const source = snapshot('2026-11-26T00:00:00Z', [
            day('2025-11-26', 99_000),
            yesterday,
            today,
            day('2026-11-27', 999_000),
        ]);
        const original = JSON.stringify(source);
        const calendar = buildActivityCalendar(source);
        expect(calendar.from).toBe('2025-11-27');
        expect(calendar.to).toBe('2026-11-26');
        expect(calendar.total).toBe(1_650);
        expect(calendar.max).toBe(1_500);
        expect(calendar.days.at(-1)).toEqual(today);
        expect(calendar.days[0].totalTokens).toBe(0);
        expect(calendar.days.some(value => value.date > '2026-11-26')).toBe(false);
        expect(JSON.stringify(source)).toBe(original);
    });

    it('pads week columns with null and places each date on its actual weekday', () => {
        const calendar = buildActivityCalendar(snapshot('2026-11-26T00:00:00Z'));
        expect(calendar.weeks).toHaveLength(53);
        expect(calendar.weeks[0].slice(0, 4)).toEqual([null, null, null, null]);
        expect(calendar.weeks[0][4]?.date).toBe('2025-11-27');
        expect(calendar.weeks.at(-1)?.slice(5)).toEqual([null, null]);
        expect(calendar.weeks.flat().filter(Boolean)).toEqual(calendar.days);
        calendar.weeks.forEach(week => {
            expect(week).toHaveLength(7);
            week.forEach((value, row) => {
                if (value) expect(new Date(`${value.date}T00:00:00Z`).getUTCDay()).toBe(row);
            });
        });
    });

    it('anchors each month at the column containing its first visible date, including a partial first month', () => {
        const calendar = buildActivityCalendar(snapshot('2026-11-26T00:00:00Z'));
        expect(calendar.months[0]).toEqual({ key: '2025-11', date: '2025-11-27', weekIndex: 0 });
        expect(calendar.months[1]).toEqual({ key: '2025-12', date: '2025-12-01', weekIndex: 1 });
        expect(calendar.months.at(-1)).toEqual({ key: '2026-11', date: '2026-11-01', weekIndex: 49 });
        calendar.months.forEach(month => {
            expect(calendar.weeks[month.weekIndex].some(value => value?.date === month.date)).toBe(true);
            expect(month.date.startsWith(month.key)).toBe(true);
        });
    });

    it('distinguishes unavailable snapshots from a valid zero-usage year', () => {
        expect(buildActivityCalendar(null)).toEqual({ days: [], weeks: [], months: [], from: null, to: null, total: 0, max: 0 });
        expect(buildActivityCalendar({ ...snapshot('2026-11-26T00:00:00Z'), scannedAt: Number.NaN }).days).toEqual([]);
        expect(buildActivityCalendar(snapshot('2026-11-26T00:00:00Z', [], 'invalid/timezone')).days).toEqual([]);
        const empty = buildActivityCalendar({ source: 'codex-session-jsonl', scannedAt: Date.parse('2026-11-26T00:00:00Z'), timeZone: 'UTC' });
        expect(empty.days).toHaveLength(365);
        expect(empty.total).toBe(0);
        expect(empty.max).toBe(0);
    });
});

describe('getActivityLevel', () => {
    it('separates zero from all positive levels and clamps values above the maximum', () => {
        expect([0, 1, 7, 26, 57, 100, 200].map(value => getActivityLevel(value, 100))).toEqual([0, 1, 2, 3, 4, 4, 4]);
        expect(getActivityLevel(-1, 100)).toBe(0);
        expect(getActivityLevel(Number.NaN, 100)).toBe(0);
        expect(getActivityLevel(10, 0)).toBe(4);
    });
});

describe('formatActivityTokens', () => {
    it('uses Chinese units adaptively without rounding small valid counts to zero', () => {
        expect(formatActivityTokens(0, 'zh-Hans')).toBe('0');
        expect(formatActivityTokens(1, 'zh-Hans')).toBe('1');
        expect(formatActivityTokens(0.25, 'zh-Hans')).toBe('0.25');
        expect(formatActivityTokens(9_999, 'zh-Hans')).toBe('9,999');
        expect(formatActivityTokens(10_000, 'zh-Hans')).toBe('1 万');
        expect(formatActivityTokens(19_140_693, 'zh-Hans')).toBe('1,914.07 万');
        expect(formatActivityTokens(1_211_000_000, 'zh-Hans')).toBe('12.11 亿');
        expect(formatActivityTokens(100_000_000, 'zh-Hant')).toBe('1 億');
        expect(formatActivityTokens(10_000, 'zh-Hant')).toBe('1 萬');
    });

    it('provides English compact units, proper rounding at boundaries and an exact detail count', () => {
        expect(formatActivityTokens(400, 'en')).toBe('400');
        expect(formatActivityTokens(1_250, 'en')).toBe('1.25K');
        expect(formatActivityTokens(12_345_678, 'en')).toBe('12.35M');
        expect(formatActivityTokens(1_250_000_000, 'en')).toBe('1.25B');
        expect(formatActivityTokens(999_999, 'en')).toBe('1M');
        expect(formatActivityTokens(99_999_999, 'zh-Hans')).toBe('1 亿');
        expect(formatActivityTokens(19_140_693, 'zh-Hans', true)).toBe('19,140,693');
        expect(formatActivityTokens(1_250, 'en', true)).toBe('1,250');
        expect(formatActivityTokens(Number.NaN, 'en')).toBe('—');
    });
});
