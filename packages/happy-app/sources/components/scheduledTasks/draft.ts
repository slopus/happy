/** Draft validation shared by the task editor and its non-visual tests. */
import { ScheduleRuleSchema, ScheduledTaskConfigSchema, scheduledDateTimeAt, type ScheduleRule, type ScheduledTaskConfig } from '@slopus/happy-wire';

export interface ScheduleDraft {
    title: string; prompt: string; machineId: string; directory: string; agent: 'codex' | 'claude'; model: string; effort: string;
    permissionMode: ScheduledTaskConfig['permissionMode']; repeat: ScheduleRule['type']; date: string; time: string; timezone: string;
    hours: string; intervalAnchor?: number; weekdays: number[]; newChatEachRun: boolean; resetBinding: boolean;
    notificationPolicy: 'all' | 'important' | 'none'; codexAccountProfileId?: string;
}
export function localScheduleDateTime(at: number, timezone: string): { date: string; time: string } {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
    const part = (key: string) => parts.find(p => p.type === key)!.value;
    return { date: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}` };
}
export function createScheduleDraft(now = Date.now()): ScheduleDraft {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    return { title: '', prompt: '', machineId: '', directory: '', agent: 'codex', model: '', effort: '', permissionMode: 'read-only',
        repeat: 'daily', date: localScheduleDateTime(now + 120000, timezone).date, time: '09:00', timezone, hours: '1', weekdays: [1],
        newChatEachRun: false, resetBinding: false, notificationPolicy: 'important' };
}
export function prepareScheduleDraft(draft: ScheduleDraft, now: number, previous?: { config: ScheduledTaskConfig; machineId: string }) {
    if (!draft.machineId || !/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(draft.directory)) throw new Error('invalid-directory');
    const config = ScheduledTaskConfigSchema.parse({ title: draft.title, prompt: draft.prompt, directory: draft.directory, agent: draft.agent,
        permissionMode: draft.permissionMode, ...(draft.agent === 'codex' && draft.model ? { model: draft.model } : {}),
        ...(draft.agent === 'codex' && draft.effort ? { effort: draft.effort } : {}),
        ...(draft.agent === 'codex' && draft.codexAccountProfileId ? { codexAccountProfileId: draft.codexAccountProfileId } : {}) });
    if (previous && !draft.resetBinding && (previous.machineId !== draft.machineId || previous.config.agent !== config.agent || previous.config.directory !== config.directory
        || previous.config.codexAccountProfileId !== config.codexAccountProfileId)) throw new Error('binding-reset-required');
    let rule: ScheduleRule;
    if (draft.repeat === 'once') {
        const at = scheduledDateTimeAt(draft.date, draft.time, draft.timezone);
        if (at === null) throw new Error('invalid-time');
        if (at <= now) throw new Error('time-must-be-future');
        rule = { type: 'once', at, timezone: draft.timezone };
    } else if (draft.repeat === 'interval') {
        rule = ScheduleRuleSchema.parse({ type: 'interval', hours: Number(draft.hours), anchor: draft.intervalAnchor ?? now + Number(draft.hours) * 3_600_000, timezone: draft.timezone });
    } else rule = ScheduleRuleSchema.parse({ type: draft.repeat, time: draft.time, timezone: draft.timezone, ...(draft.repeat === 'weekly' ? { weekdays: draft.weekdays } : {}) });
    return { config, rule, resetBinding: draft.resetBinding };
}
