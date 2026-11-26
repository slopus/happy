import type { ActivitySnapshot } from '../../../sources/components/usage/codexActivityCalendar';

// Public, deterministic fixture data. No user sessions or authentication are read.
export function fixtureSnapshot(): ActivitySnapshot {
    const scannedAt = Date.parse('2026-11-25T11:00:00Z');
    return {
        source: 'codex-session-jsonl', scannedAt, timeZone: 'Asia/Shanghai',
        days: Array.from({ length: 60 }, (_, index) => {
            const date = new Date(Date.UTC(2026, 10, 25 - (59 - index))).toISOString().slice(0, 10);
            const total = index === 59 ? 1_214_884_168 : (index * 19 % 47 + 2) * 3_700_000;
            const output = index === 59 ? 4_003_231 : Math.round(total * 0.015);
            const input = total - output;
            return {
                date, totalTokens: total, inputTokens: input, cachedInputTokens: Math.floor(input * 0.98),
                outputTokens: output, reasoningOutputTokens: Math.floor(output / 3),
                tokenCountEvents: 70 + index, sessions: 4 + index % 11, totalOnlyTokens: 0,
            };
        }),
    };
}

export const machine = { id: 'usage-fixture-machine', active: true, daemonState: { codexUsage: fixtureSnapshot() } };
const quota = (remainingPercent: number) => ({
    state: 'current', remainingPercent, observedAt: '2026-11-25T11:00:00Z', weeklyResetsAt: '2099-11-26T09:16:15Z',
});
export const profiles = [
    { id: 'fixture-google', displayName: 'google', quota: quota(34) },
    { id: 'fixture-qq', displayName: 'qq 邮箱', quota: quota(77) },
];
