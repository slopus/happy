import { describe, expect, it } from 'vitest';
import {
    AgentRolesInputSchema, DelegateTaskInputSchema, DelegationRequestSchema,
    DelegationRoleInputSchema, DelegatedTaskSchema, isDelegatedTaskSettled,
} from './delegation';

const role = { id: 'writer', name: 'Writer', description: 'Write grounded drafts', agent: 'antigravity', model: 'gemini-4-neon', autoDelegate: true };

describe('delegation contracts', () => {
    it('keeps execution selection separate from role prose and forbids credentials or arbitrary shell configuration', () => {
        expect(DelegationRoleInputSchema.parse(role)).toEqual(role);
        for (const extra of [{ command: 'agy' }, { apiKey: 'never-store' }, { environmentVariables: {} }, { createdAt: 1 }]) {
            expect(DelegationRoleInputSchema.safeParse({ ...role, ...extra }).success).toBe(false);
        }
        expect(AgentRolesInputSchema.safeParse({ action: 'save', role, parentSessionId: 'other' }).success).toBe(false);
    });

    it('requires a role for a new task and the same task identity for a revision, never both', () => {
        const start = { requestId: 'stable-request', prompt: 'Write the README' };
        expect(DelegateTaskInputSchema.safeParse(start).success).toBe(false);
        expect(DelegateTaskInputSchema.safeParse({ ...start, roleId: 'writer' }).success).toBe(true);
        expect(DelegateTaskInputSchema.safeParse({ ...start, taskId: 'same-task' }).success).toBe(true);
        expect(DelegateTaskInputSchema.safeParse({ ...start, taskId: 'same-task', roleId: 'writer' }).success).toBe(false);
        expect(DelegateTaskInputSchema.safeParse({ ...start, roleId: 'writer', parentSessionId: 'other' }).success).toBe(false);
        expect(DelegateTaskInputSchema.safeParse({ ...start, roleId: '../escape' }).success).toBe(false);
        expect(DelegationRequestSchema.safeParse({ action: 'start', parentSessionId: 'parent', ...start, roleId: 'writer', wait: true }).success).toBe(true);
        expect(DelegationRequestSchema.safeParse({ action: 'start', parentSessionId: 'parent', ...start, wait: true }).success).toBe(false);
    });

    it('keeps actual version numbers, opaque native turn ids, and cancel requests distinct from termination', () => {
        const detail = DelegatedTaskSchema.parse({
            id: 'task', parentSessionId: 'parent', childSessionId: 'child', title: 'README', roleId: 'writer', roleName: 'Writer',
            agent: 'antigravity', model: 'gemini-4-neon', version: 3, status: 'running', startedAt: 1, updatedAt: 5,
            resultAvailable: false, cancelRequested: true, prompt: 'Revise the draft',
            history: [{ version: 1, prompt: 'Original draft', status: 'completed', startedAt: 1, updatedAt: 2, finishedAt: 2, result: { text: 'v1', turnId: 'native:turn/one' } }],
        });
        expect(detail.history[0].version).toBe(1);
        expect(detail.version).toBe(3);
        expect(isDelegatedTaskSettled(detail.status)).toBe(false);
        expect(isDelegatedTaskSettled('waiting-for-input')).toBe(true);
        expect(isDelegatedTaskSettled('interrupted')).toBe(true);
    });
});
