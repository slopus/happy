import { expect, it } from 'vitest';
import { createScheduleDraft, prepareScheduleDraft } from './draft';

it('validates a future local date and preserves a fixed interval anchor on edits', () => {
    const now = Date.parse('2026-11-23T00:00:00Z');
    const draft = { ...createScheduleDraft(now), title: 'News', prompt: 'Summarize news', machineId: 'machine', directory: '/work',
        repeat: 'once' as const, date: '2026-11-23', time: '09:00', timezone: 'Asia/Shanghai' };
    expect(prepareScheduleDraft(draft, now).rule).toEqual({ type: 'once', at: Date.parse('2026-11-23T01:00:00Z'), timezone: 'Asia/Shanghai' });
    expect(() => prepareScheduleDraft({ ...draft, time: '07:00' }, now)).toThrow('time-must-be-future');
    expect(() => prepareScheduleDraft({ ...draft, prompt: '  ' }, now)).toThrow();
    expect(prepareScheduleDraft({ ...draft, repeat: 'interval', hours: '2', intervalAnchor: now - 1000 }, now).rule)
        .toEqual({ type: 'interval', hours: 2, anchor: now - 1000, timezone: 'Asia/Shanghai' });
});
it('requires an explicit conversation reset for incompatible fixed-session changes', () => {
    const draft = { ...createScheduleDraft(1000), title: 'Task', prompt: 'Go', machineId: 'machine', directory: '/new' };
    const previous = { agent: 'codex' as const, directory: '/old', permissionMode: 'read-only' as const, title: 'Task', prompt: 'Go' };
    expect(() => prepareScheduleDraft(draft, 1000, { config: previous, machineId: 'machine' })).toThrow('binding-reset-required');
    expect(prepareScheduleDraft({ ...draft, resetBinding: true }, 1000, { config: previous, machineId: 'machine' }).resetBinding).toBe(true);
});
