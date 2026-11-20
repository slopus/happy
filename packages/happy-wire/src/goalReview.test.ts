import { describe, expect, it } from 'vitest';
import { changeGoalTaskStatus, undoGoalTaskStatus, readGoalReview, writeGoalReview, emptyGoalReview } from './goalReview';
const original = '---\nstatus: pending\ntask_id: GFT-abcdefgh\n---\n# Task\nUser notes\n';
const event = { id: 'change-1', at: 1, actor: 'user' as const, reason: 'I know the work is finished', evidence: ['User changed progress; not delivery recognition'] };
describe('task review records', () => {
    it('changes only progress, preserves identity and notes, and does not manufacture acceptance', () => {
        const result = changeGoalTaskStatus(original, 'done', event);
        expect(result).toContain('status: done\ntask_id: GFT-abcdefgh');
        expect(result).toContain('# Task\nUser notes');
        expect(readGoalReview(result)?.recognitions).toEqual([]);
        expect(readGoalReview(result)?.statusChanges[0]).toMatchObject({ from: 'pending', to: 'done', ...event });
    });
    it('undoes the latest correction without overwriting later document edits or erasing audit evidence', () => {
        const changed = changeGoalTaskStatus(original, 'done', event) + '\nLater user note\n';
        const undone = undoGoalTaskStatus(changed, event.id, 2);
        expect(undone).toContain('status: pending');
        expect(undone).toContain('Later user note');
        expect(readGoalReview(undone)?.statusChanges[0].revertedAt).toBe(2);
        expect(() => undoGoalTaskStatus(undone, event.id, 3)).toThrow();
    });
    it('refuses undo after an unrecorded or later state change', () => {
        const changed = changeGoalTaskStatus(original, 'done', event);
        expect(() => undoGoalTaskStatus(changed.replace('status: done', 'status: running'), event.id, 2)).toThrow();
        const newer = changeGoalTaskStatus(changed, 'review', { ...event, id: 'change-2', at: 2 });
        expect(() => undoGoalTaskStatus(newer, event.id, 3)).toThrow();
    });
    it('round trips questions, gaps and evidence while preserving the surrounding document', () => {
        const review = { ...emptyGoalReview(), summary: 'Located final video', decisions: [{ id: 'final', question: 'Which cut is final?', recommendation: 'Use v3' }], gaps: ['Device test not performed'], evidence: ['report.md: final export'] };
        expect(readGoalReview(writeGoalReview(original, review))).toEqual(review);
    });
    it('fails closed on malformed/duplicated metadata and oversized documents', () => {
        expect(() => writeGoalReview(original + '<!-- paws:review:start -->\nbroken', emptyGoalReview())).toThrow();
        const good = writeGoalReview(original, emptyGoalReview());
        expect(() => readGoalReview(good + good)).toThrow();
        expect(() => changeGoalTaskStatus(original.replace('status: pending', 'status: pending\nstatus: done'), 'done', event)).toThrow();
        expect(() => writeGoalReview('x'.repeat(256 * 1024), emptyGoalReview())).toThrow();
    });
    it('adds a missing YAML status without rewriting the task body and supports CRLF', () => {
        expect(changeGoalTaskStatus('# Legacy\n', 'done', event)).toContain('status: done');
        expect(changeGoalTaskStatus(original.replace(/\n/g, '\r\n'), 'done', event)).toContain('status: done\r\ntask_id:');
    });
});

describe('version-scoped historical recognition', () => {
    it('reuses explicit recognition only for the exact current output', async () => {
        const { goalOutputRecognition } = await import('./goalReview');
        const task = { indexPath: '/project/tasks/01/index.md', review: { ...emptyGoalReview(), recognitions: [{ target: 'final.mp4', revision: 'a'.repeat(24), evidence: ['User: the video is good, session abc'] }] } };
        expect(goalOutputRecognition(task, { path: '/project/tasks/01/final.mp4', revision: 'a'.repeat(24) })).toBeTruthy();
        expect(goalOutputRecognition(task, { path: '/project/tasks/01/final.mp4', revision: 'b'.repeat(24) })).toBeUndefined();
        expect(goalOutputRecognition(task, { path: '/project/tasks/02/final.mp4', revision: 'a'.repeat(24) })).toBeUndefined();
    });
});

it('normalizes dot segments for local recognition and fails closed for mutable URLs', async () => {
    const { goalOutputRecognition } = await import('./goalReview');
    const revision = 'a'.repeat(24);
    const task = { indexPath: '/project/tasks/01/index.md', review: { ...emptyGoalReview(), recognitions: [{ target: './final.mp4', revision, evidence: ['User approved v1'] }, { target: 'https://example.com/latest.mp4', revision, evidence: ['User approved v1'] }] } };
    expect(goalOutputRecognition(task, { path: '/project/tasks/01/final.mp4', revision })).toBeTruthy();
    expect(goalOutputRecognition(task, { url: 'https://example.com/latest.mp4', revision })).toBeUndefined();
});

it('round trips user answers containing metadata marker text without corrupting the task', () => {
    const review = { ...emptyGoalReview(), decisions: [{ id: 'note', question: 'Which format?', answer: 'Use <!-- paws:review:start --> and <!-- paws:delivery:start --> as examples' }] };
    expect(readGoalReview(writeGoalReview(original, review))).toEqual(review);
});
