import { describe, expect, it } from 'vitest';
import { GoalDeliveryAgreementSchema, readGoalDeliveryAgreement, writeGoalDeliveryAgreement, relativeGoalDeliveryFile } from './goalDelivery';

describe('portable task delivery agreement', () => {
    it.each([
        ['C:\\goals\\task', 'C:\\goals\\task\\output\\result.md', 'output/result.md'],
        ['/goals/task/', '/goals/task/output/result.md', 'output/result.md'],
        ['/goals/task', '/goals/task-other/result.md', undefined],
        ['C:\\goals\\task', 'C:\\goals\\other\\result.md', undefined],
    ])('retains existing final paths under %s across transport separators', (root, path, expected) => {
        expect(relativeGoalDeliveryFile(root!, path!)).toBe(expected);
    });
    const agreement = { expectedDeliverables: ['三个页面', 'A report with $& and $`'], acceptanceCriteria: ['All pages open'], finalOutputs: [{ name: '对比报告', target: '成果/报告 #1 (完成).md' }, { name: 'Live site', target: 'https://example.com/demo?a=1#part' }] };
    it('round-trips Unicode paths and literal replacement tokens without changing existing notes', () => {
        const original = '---\nstatus: done\n---\n# Task\n\nSome original notes.\n';
        const saved = writeGoalDeliveryAgreement(original, agreement);
        expect(saved.startsWith(original)).toBe(true);
        expect(readGoalDeliveryAgreement(saved)).toEqual(agreement);
        expect(saved).toContain('对比报告');
        const changed = writeGoalDeliveryAgreement(saved, { ...agreement, expectedDeliverables: ['New promise'], finalOutputs: [] });
        expect(changed.match(/paws:delivery:start/g)).toHaveLength(1);
        expect(readGoalDeliveryAgreement(changed)?.finalOutputs).toEqual([]);
        expect(changed).toContain('Some original notes.');
    });
    it.each(['../other.md', '/private/file.md', 'C:\\private\\x.md', 'javascript:alert(1)', 'index.md', 'a/../../file.md'])('rejects unsafe final target %s', target => {
        expect(GoalDeliveryAgreementSchema.safeParse({ ...agreement, finalOutputs: [{ name: 'Invalid', target }] }).success).toBe(false);
    });
    it('does not overwrite a malformed block', () => {
        expect(() => writeGoalDeliveryAgreement('# Task\n<!-- paws:delivery:start -->\npartial', agreement)).toThrow();
    });
    it('rejects an agreement that would make the index unreadable to the board parser', () => {
        const largeIndex = '# Task\n' + 'x'.repeat(250 * 1024);
        expect(() => writeGoalDeliveryAgreement(largeIndex, { ...agreement, expectedDeliverables: Array(4).fill('y'.repeat(2048)) })).toThrow('size limit');
    });
});
