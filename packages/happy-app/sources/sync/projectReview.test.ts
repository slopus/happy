import { describe, expect, it } from 'vitest';
import { buildRetrospectivePrompt, reviewAttention } from './projectReview';
import type { GoalTask } from '@slopus/happy-wire';
const task = { id: 'GFT-abcdefgh', title: 'Video', indexPath: '/project/features/video/tasks/01/index.md', status: 'done', artifacts: [], expectedDeliverables: [], dependencies: [], goal: '' } as GoalTask;
describe('retrospective scope and attention', () => {
    it('keeps record gaps neutral and only raises concrete decisions and work gaps', () => {
        expect(reviewAttention(task)).toEqual({ decisions: [], gaps: [] });
        expect(reviewAttention({ ...task, review: { summary: '', evidence: [], recognitions: [], statusChanges: [], decisions: [{ id: 'a', question: 'Which cut?', answer: 'v3' }, { id: 'b', question: 'Publish?' }], gaps: ['Device test was not run'] } })).toEqual({ decisions: [{ id: 'b', question: 'Publish?' }], gaps: ['Device test was not run'] });
    });
    it('names exactly the selected task paths, and does not authorize missing business work', () => {
        const prompt = buildRetrospectivePrompt('/project', [task]);
        expect(prompt).toContain(task.indexPath);
        expect(prompt).toContain(task.id);
        expect(prompt).toContain('不得补做');
        expect(prompt).toContain('撤回');
        expect(() => buildRetrospectivePrompt('/project', [])).toThrow();
    });
});
