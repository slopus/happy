import { describe, expect, it } from 'vitest';
import { GoalTaskSchema, GoalBoardSnapshotSchema, GoalBoardArtifactResponseSchema } from './goalBoard';

describe('Goal Board wire contract', () => {
    it('preserves unknown status when task status is absent or invalid', () => {
        const task = { id: 'a', title: 'Task', indexPath: '/goals/task/index.md', goal: '', dependencies: [], expectedDeliverables: [], artifacts: [] };
        expect(GoalTaskSchema.parse(task).status).toBe('unknown');
        expect(GoalTaskSchema.parse({ ...task, status: 'completed' }).status).toBe('unknown');
        expect(GoalTaskSchema.parse({ ...task, status: 'review' }).status).toBe('review');
    });
    it('bounds encrypted metadata snapshots', () => {
        expect(GoalBoardSnapshotSchema.safeParse({ featurePath: 'x', title: 'x', revision: 'x', updatedAt: 0, tasks: [], warnings: [] }).success).toBe(true);
        expect(GoalBoardSnapshotSchema.safeParse({ featurePath: 'x', title: 'x', revision: 'x', updatedAt: 0, tasks: Array(201).fill({}), warnings: [] }).success).toBe(false);
    });
    it('validates attachment identity, lane, MIME and bounded payload size', () => {
        const response = { success: true, kind: 'attachment', attachment: { ref: 'ref', name: '报告.pdf', size: 1024, mimeType: 'application/pdf', kind: 'file', encrypted: true } };
        expect(GoalBoardArtifactResponseSchema.safeParse(response).success).toBe(true);
        expect(GoalBoardArtifactResponseSchema.safeParse({ ...response, attachment: { ...response.attachment, ref: '' } }).success).toBe(false);
        expect(GoalBoardArtifactResponseSchema.safeParse({ ...response, attachment: { ...response.attachment, mimeType: 'invalid MIME' } }).success).toBe(false);
        expect(GoalBoardArtifactResponseSchema.safeParse({ ...response, attachment: { ...response.attachment, size: 500 * 1024 * 1024 + 1 } }).success).toBe(false);
    });

});
