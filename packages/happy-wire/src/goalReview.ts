import { z } from 'zod';

const text = z.string().trim().min(1).max(2048);
const state = z.enum(['pending', 'running', 'review', 'done', 'blocked', 'unknown']);
const evidence = z.array(text).min(1).max(30);
const changeSchema = z.object({
    id: text, at: z.number().nonnegative(), actor: z.enum(['user', 'ai']), reason: text, evidence,
    from: state, to: state, revertedAt: z.number().nonnegative().optional(),
});
export const GoalReviewSchema = z.object({
    summary: z.string().max(2048), evidence: z.array(text).max(30),
    decisions: z.array(z.object({ id: text, question: text, recommendation: text.optional(), answer: text.optional() })).max(30),
    gaps: z.array(text).max(30),
    // An explicit user statement applies to exactly this artifact revision, never task status.
    recognitions: z.array(z.object({ target: text, revision: z.string().regex(/^[a-f0-9]{24}$/), evidence })).max(30),
    statusChanges: z.array(changeSchema).max(100),
}).superRefine((value, ctx) => {
    for (const key of ['decisions', 'statusChanges'] as const) {
        const ids = value[key].map(item => item.id);
        if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: `Duplicate ${key} identity`, path: [key] });
    }
});
export type GoalReview = z.infer<typeof GoalReviewSchema>;
export type GoalStatusChange = z.infer<typeof changeSchema>;
export function emptyGoalReview(): GoalReview { return { summary: '', evidence: [], decisions: [], gaps: [], recognitions: [], statusChanges: [] }; }
const start = '<!-- paws:review:start -->';
const end = '<!-- paws:review:end -->';
const pattern = /^<!-- paws:review:start -->\r?\n```json\r?\n([\s\S]*?)\r?\n```\r?\n<!-- paws:review:end -->[ \t]*$/m;
export function readGoalReview(source: string): GoalReview | undefined {
    const starts = source.split(start).length - 1, ends = source.split(end).length - 1;
    if (!starts && !ends) return;
    if (starts !== 1 || ends !== 1) throw new Error('Malformed or duplicate task review');
    const match = source.match(pattern);
    if (!match) throw new Error('Malformed task review');
    return GoalReviewSchema.parse(JSON.parse(match[1]));
}
export function withoutGoalReview(source: string): string { readGoalReview(source); return source.replace(pattern, ''); }
export function writeGoalReview(source: string, input: GoalReview): string {
    readGoalReview(source);
    const value = GoalReviewSchema.parse(input);
    const block = `${start}\n\`\`\`json\n${JSON.stringify(value, null, 2).replace(/</g, '\\u003c')}\n\`\`\`\n${end}`;
    const result = pattern.test(source) ? source.replace(pattern, () => block) : `${source.trimEnd()}\n\n${block}\n`;
    if (new TextEncoder().encode(result).length > 256 * 1024) throw new Error('Task index exceeds size limit');
    return result;
}
export function readGoalTaskStatus(source: string): z.infer<typeof state> {
    const front = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!front) { if (source.startsWith('---')) throw new Error('Malformed task frontmatter'); return 'unknown'; }
    const lines = front[1].split(/\r?\n/).filter(line => /^status\s*:/.test(line));
    if (lines.length > 1) throw new Error('Duplicate task status');
    const value = lines[0]?.replace(/^status\s*:\s*/, '').replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2').trim();
    return value ? state.parse(value) : 'unknown';
}
function withStatus(source: string, status: z.infer<typeof state>) {
    readGoalTaskStatus(source);
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const front = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!front) return `---${newline}status: ${status}${newline}---${newline}${source}`;
    const lines = front[1].split(/\r?\n/);
    const index = lines.findIndex(line => /^status\s*:/.test(line));
    if (index < 0) lines.push(`status: ${status}`); else lines[index] = `status: ${status}`;
    return `---${newline}${lines.join(newline)}${newline}---${newline}${source.slice(front[0].length)}`;
}
export function changeGoalTaskStatus(source: string, status: z.infer<typeof state>, event: Omit<GoalStatusChange, 'from' | 'to' | 'revertedAt'>): string {
    const from = readGoalTaskStatus(source); state.parse(status);
    if (from === status) return source;
    const review = readGoalReview(source) ?? emptyGoalReview();
    const change = changeSchema.parse({ ...event, from, to: status });
    return writeGoalReview(withStatus(source, status), { ...review, statusChanges: [...review.statusChanges, change] });
}
export function undoGoalTaskStatus(source: string, id: string, at: number): string {
    const review = readGoalReview(source);
    const change = review?.statusChanges.at(-1);
    if (!review || !change || change.id !== id || change.revertedAt !== undefined || readGoalTaskStatus(source) !== change.to)
        throw new Error('Task status changed; refresh before undoing');
    return writeGoalReview(withStatus(source, change.from), { ...review, statusChanges: review.statusChanges.map(item => item.id === id ? { ...item, revertedAt: at } : item) });
}

/** Used by ordinary task sessions too; maintenance is event-driven, never a background scan. */
export const GOAL_MAINTENANCE_INSTRUCTION = `For Goal First work, first read goal-first-ops and goal-first from their installed Skill paths. During authorized task work, maintain the original task's expected deliverables, acceptance criteria, actual final outputs and progress from the real conversation and evidence. Use goal-first's retrospective/record helper for review records and reversible status changes. Task progress and user recognition of a particular deliverable are separate: done never implies recognition. Reuse explicit historical user recognition with its source and exact output version; never manufacture it. Ask immediately only when missing information blocks authorized work; collect other questions for retrospective review. In discussion/read-only mode do not mutate records. A retrospective request authorizes organizing existing records and correcting documented state, not completing missing implementation, tests, generation or releases; list such gaps for the user to start separately.`;

export function goalOutputRecognition(task: { indexPath: string; review?: GoalReview }, output: { path?: string; url?: string; revision?: string }) {
    const root = task.indexPath.replace(/[\\/][^\\/]+$/, '').replace(/\\/g, '/');
    return task.review?.recognitions.find(record => {
        // A URL digest identifies a link, not mutable remote content.
        if (/^https?:\/\//i.test(record.target)) return false;
        const relative = record.target.replace(/\\/g, '/').split('/').filter(part => part && part !== '.');
        if (relative.includes('..')) return false;
        const target = `${root}/${relative.join('/')}`;
        return (target === output.url || target === output.path?.replace(/\\/g, '/')) && record.revision === output.revision;
    });
}
