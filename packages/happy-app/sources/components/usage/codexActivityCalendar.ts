/** Daily activity is already aggregated by the execution host. Cache is part of input. */
export interface ActivityDay {
    date: string;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
    tokenCountEvents: number;
    sessions: number;
    totalOnlyTokens: number;
}

export interface ActivitySnapshot {
    source: 'codex-session-jsonl';
    scannedAt: number;
    timeZone?: string;
    days?: ActivityDay[];
}

export interface ActivityMonth {
    key: string;
    /** A calendar date in this month, for the view to localize without a timezone shift. */
    date: string;
    weekIndex: number;
}

export interface ActivityCalendar {
    days: ActivityDay[];
    /** Week columns, each with seven Sunday-to-Saturday cells. Padding is not a day. */
    weeks: Array<Array<ActivityDay | null>>;
    months: ActivityMonth[];
    from: string | null;
    to: string | null;
    total: number;
    max: number;
}

export type ActivityLevel = 0 | 1 | 2 | 3 | 4;

const CALENDAR_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1_000;

function emptyCalendar(): ActivityCalendar {
    return { days: [], weeks: [], months: [], from: null, to: null, total: 0, max: 0 };
}

function emptyDay(date: string): ActivityDay {
    return {
        date,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
        tokenCountEvents: 0,
        sessions: 0,
        totalOnlyTokens: 0,
    };
}

function snapshotDate(snapshot: ActivitySnapshot): string | null {
    if (!Number.isFinite(snapshot.scannedAt)) return null;
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: snapshot.timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).formatToParts(new Date(snapshot.scannedAt));
        const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(value => value.type === type)?.value;
        return `${part('year')}-${part('month')}-${part('day')}`;
    } catch {
        // An unavailable timezone or timestamp must not silently move usage to another day.
        return null;
    }
}

/** A rolling 365 natural days ending on the snapshot's day in the host's timezone. */
export function buildActivityCalendar(snapshot: ActivitySnapshot | null | undefined): ActivityCalendar {
    if (!snapshot) return emptyCalendar();
    const to = snapshotDate(snapshot);
    if (!to) return emptyCalendar();

    // UTC here is only a date-arithmetic container. The actual end date was resolved above.
    // Adding fixed days to this container avoids DST changing a calendar date or weekday.
    const end = Date.parse(`${to}T00:00:00.000Z`);
    const start = end - (CALENDAR_DAYS - 1) * DAY_MS;
    const byDate = new Map(snapshot.days?.map(day => [day.date, day]));
    const days = Array.from({ length: CALENDAR_DAYS }, (_, index) => {
        const date = new Date(start + index * DAY_MS).toISOString().slice(0, 10);
        return byDate.get(date) ?? emptyDay(date);
    });

    const leading = new Date(start).getUTCDay();
    const weeks: Array<Array<ActivityDay | null>> = Array.from(
        { length: Math.ceil((leading + days.length) / 7) },
        () => Array<ActivityDay | null>(7).fill(null),
    );
    const months: ActivityMonth[] = [];
    let total = 0;
    let max = 0;
    days.forEach((day, index) => {
        const position = leading + index;
        const weekIndex = Math.floor(position / 7);
        weeks[weekIndex][position % 7] = day;
        if (index === 0 || day.date.endsWith('-01')) {
            months.push({ key: day.date.slice(0, 7), date: day.date, weekIndex });
        }
        // totalTokens includes cached input and reasoning output; neither is added again.
        total += day.totalTokens;
        max = Math.max(max, day.totalTokens);
    });

    return { days, weeks, months, from: days[0].date, to, total, max };
}

/** Square-root scaling keeps small positive days visible beside a very busy day. */
export function getActivityLevel(total: number, max: number): ActivityLevel {
    if (!Number.isFinite(total) || total <= 0) return 0;
    const ceiling = Number.isFinite(max) && max > 0 ? max : total;
    return Math.min(4, Math.ceil(4 * Math.sqrt(Math.min(1, total / ceiling)))) as ActivityLevel;
}

function numberLocale(language: string): string {
    if (language === 'zh-Hans') return 'zh-CN';
    if (language === 'zh-Hant') return 'zh-TW';
    try {
        return Intl.getCanonicalLocales(language)[0] || 'en-US';
    } catch {
        return 'en-US';
    }
}

/** Compact presentation only; exact=true retains the full count for detail/accessible text. */
export function formatActivityTokens(tokens: number, language: string, exact = false): string {
    if (!Number.isFinite(tokens)) return '—';
    const locale = numberLocale(language);
    const count = Math.max(0, tokens);
    const chinese = /^zh(?:-|$)/i.test(language);
    const traditional = /^zh-(?:Hant(?:-|$)|TW(?:-|$)|HK(?:-|$)|MO(?:-|$))/i.test(language);
    const units = chinese
        ? [{ scale: 100_000_000, suffix: traditional ? ' 億' : ' 亿' }, { scale: 10_000, suffix: traditional ? ' 萬' : ' 万' }]
        : [{ scale: 1_000_000_000, suffix: 'B' }, { scale: 1_000_000, suffix: 'M' }, { scale: 1_000, suffix: 'K' }];
    if (!exact) {
        for (let index = 0; index < units.length; index += 1) {
            const unit = units[index];
            if (count < unit.scale) continue;
            const rounded = Math.round(count / unit.scale * 100) / 100;
            const larger = units[index - 1];
            // Avoid 1,000K or 10,000万 after rounding at a unit boundary.
            if (larger && rounded * unit.scale >= larger.scale) {
                return `${(count / larger.scale).toLocaleString(locale, { maximumFractionDigits: 2 })}${larger.suffix}`;
            }
            return `${rounded.toLocaleString(locale, { maximumFractionDigits: 2 })}${unit.suffix}`;
        }
    }
    return count.toLocaleString(locale, { maximumFractionDigits: 20 });
}
