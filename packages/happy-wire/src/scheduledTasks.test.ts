import { describe, expect, it } from 'vitest';
import { nextScheduledAt, scheduledDateTimeAt, ScheduleRuleSchema, ScheduledTaskConfigSchema } from './scheduledTasks';

// These literal UTC instants catch timezone drift, duplicate DST folds and off-by-one due times.
describe('nextScheduledAt', () => {
    it('converts a selected local date and rejects invalid dates and DST gaps', () => {
        expect(scheduledDateTimeAt('2026-11-23', '09:15', 'Asia/Shanghai')).toBe(Date.parse('2026-11-23T01:15:00Z'));
        expect(scheduledDateTimeAt('2026-03-08', '02:30', 'America/New_York')).toBeNull();
        expect(scheduledDateTimeAt('2026-02-30', '09:00', 'UTC')).toBeNull();
    });
    it('consumes a once deadline and advances an interval without replaying missed hours', () => {
        expect(nextScheduledAt({ type: 'once', at: 2000, timezone: 'UTC' }, 1999)).toBe(2000);
        expect(nextScheduledAt({ type: 'once', at: 2000, timezone: 'UTC' }, 2000)).toBeNull();
        expect(nextScheduledAt({ type: 'interval', anchor: 1000, hours: 2, timezone: 'UTC' }, 8_000_000)).toBe(14_401_000);
    });
    it('uses the saved timezone and strictly advances past an exact daily deadline', () => {
        const rule = { type: 'daily', time: '09:00', timezone: 'Asia/Shanghai' } as const;
        expect(nextScheduledAt(rule, Date.parse('2026-11-23T00:00:00Z'))).toBe(Date.parse('2026-11-23T01:00:00Z'));
        expect(nextScheduledAt(rule, Date.parse('2026-11-23T01:00:00Z'))).toBe(Date.parse('2026-11-24T01:00:00Z'));
    });
    it('supports multiple weekdays across a year boundary', () => {
        expect(nextScheduledAt({ type: 'weekly', time: '09:30', timezone: 'UTC', weekdays: [1, 4] }, Date.parse('2026-12-31T10:00:00Z')))
            .toBe(Date.parse('2027-01-04T09:30:00Z'));
    });
    it('skips a nonexistent spring-forward time', () => {
        expect(nextScheduledAt({ type: 'daily', time: '02:30', timezone: 'America/New_York' }, Date.parse('2026-03-08T05:00:00Z')))
            .toBe(Date.parse('2026-03-09T06:30:00Z'));
    });
    it('runs only the first occurrence of a fall-back local time', () => {
        const rule = { type: 'daily', time: '01:30', timezone: 'America/New_York' } as const;
        expect(nextScheduledAt(rule, Date.parse('2026-11-01T04:00:00Z'))).toBe(Date.parse('2026-11-01T05:30:00Z'));
        expect(nextScheduledAt(rule, Date.parse('2026-11-01T05:30:00Z'))).toBe(Date.parse('2026-11-02T06:30:00Z'));
    });
    it('handles a half-hour timezone without rounding to full hours', () => {
        expect(nextScheduledAt({ type: 'daily', time: '09:00', timezone: 'Asia/Kolkata' }, Date.parse('2026-11-23T00:00:00Z')))
            .toBe(Date.parse('2026-11-23T03:30:00Z'));
    });
    it('rejects malformed rules and empty/private execution configuration', () => {
        for (const input of [
            { type: 'daily', time: '25:00', timezone: 'UTC' },
            { type: 'daily', time: '09:00', timezone: 'Not/AZone' },
            { type: 'weekly', time: '09:00', timezone: 'UTC', weekdays: [] },
            { type: 'interval', anchor: 1, hours: 0, timezone: 'UTC' },
        ]) expect(ScheduleRuleSchema.safeParse(input).success).toBe(false);
        expect(ScheduledTaskConfigSchema.safeParse({ title: 'task', prompt: '  ', directory: '/tmp', agent: 'codex' }).success).toBe(false);
    });
});
