import { describe, expect, it } from 'vitest';
import { discussionMessage, discussionModeMeta } from './discussionMode';

describe('discussion policy', () => {
    it.each([['codex', 'read-only'], ['claude', 'plan']])('restricts %s without discarding model choices', (flavor, permissionMode) => {
        expect(discussionModeMeta({ permissionMode: 'yolo', model: 'model', effort: 'high', fast: true }, flavor))
            .toEqual({ permissionMode, permissionModeExplicit: true, model: 'model', effort: 'high', fast: true });
    });
    it('rejects agents without a supported permission boundary', () => {
        expect(() => discussionModeMeta({}, 'opencode')).toThrow();
    });
    it('distinguishes project and task context and retains the user message', () => {
        const project = discussionMessage('Why?', { featurePath: '/project' });
        const task = discussionMessage('Why?', { featurePath: '/project', taskId: 'task-1' });
        expect(project).toContain('Scope: project purpose.');
        expect(task).toContain('Current task: task-1');
        expect(task).toContain('Authoritative project context: /project');
        expect(task).toContain('User message:\nWhy?');
        expect(discussionMessage('Hello')).toContain('do not invent missing context');
    });
});
