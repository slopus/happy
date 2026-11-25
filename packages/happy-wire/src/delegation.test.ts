import { describe, expect, it } from 'vitest';
import {
    AgentRolesInputSchema, DelegateTaskInputSchema, DelegationRequestSchema,
    DelegationRoleInputSchema, DelegatedTaskSchema, isDelegatedTaskSettled,
    MachineDelegationRolesRequestSchema, DelegationRoleCreateInputSchema, DelegateTaskToolInputSchema,
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

    it('requires exactly one saved role, temporary route, or same task identity', () => {
        const start = { requestId: 'stable-request', prompt: 'Write the README' };
        expect(DelegateTaskInputSchema.safeParse(start).success).toBe(false);
        expect(DelegateTaskInputSchema.safeParse({ ...start, roleId: 'writer' }).success).toBe(true);
        expect(DelegateTaskInputSchema.safeParse({ ...start, taskId: 'same-task' }).success).toBe(true);
        expect(DelegateTaskInputSchema.safeParse({ ...start, taskId: 'same-task', roleId: 'writer' }).success).toBe(false);
        expect(DelegateTaskInputSchema.safeParse({ ...start, roleId: 'writer', parentSessionId: 'other' }).success).toBe(false);
        expect(DelegateTaskInputSchema.safeParse({ ...start, roleId: '../escape' }).success).toBe(false);
        expect(DelegationRequestSchema.safeParse({ action: 'start', parentSessionId: 'parent', ...start, roleId: 'writer', wait: true }).success).toBe(true);
        expect(DelegationRequestSchema.safeParse({ action: 'roles-list', parentSessionId: 'parent', protocolVersion: 2 }).success).toBe(true);
        expect(DelegationRequestSchema.safeParse({ action: 'read', parentSessionId: 'parent', taskId: 'same-task', protocolVersion: 3 }).success).toBe(false);
        expect(DelegateTaskToolInputSchema.safeParse({ ...start, roleId: 'writer', intent: 'explicit', protocolVersion: 2 }).success).toBe(false);
        expect(DelegationRequestSchema.safeParse({ action: 'start', parentSessionId: 'parent', ...start, wait: true }).success).toBe(false);
        expect(DelegateTaskInputSchema.safeParse({ ...start, route: { agent: 'antigravity' }, intent: 'explicit' }).success).toBe(true);
        expect(DelegateTaskInputSchema.safeParse({ ...start, route: { agent: 'antigravity' }, roleId: 'writer' }).success).toBe(false);
        expect(DelegateTaskInputSchema.safeParse({ ...start, route: { agent: 'antigravity', command: 'agy' } }).success).toBe(false);
        expect(DelegateTaskToolInputSchema.safeParse({ ...start, roleId: 'writer' }).success).toBe(false);
        expect(DelegateTaskToolInputSchema.safeParse({ ...start, roleId: 'writer', intent: 'automatic' }).success).toBe(true);
        expect(DelegateTaskToolInputSchema.safeParse({ ...start, roleId: 'writer', intent: 'human-approved' }).success).toBe(false);
    });

    it('separates create from stable-ID patch and defaults new roles to manual without requiring a parent', () => {
        const { id: _id, model: _model, autoDelegate: _auto, ...draft } = role;
        expect(DelegationRoleCreateInputSchema.parse(draft)).toEqual({ ...draft, autoDelegate: false });
        expect(MachineDelegationRolesRequestSchema.parse({ action: 'create', role: draft })).toMatchObject({ role: { autoDelegate: false } });
        expect(MachineDelegationRolesRequestSchema.safeParse({ action: 'update', roleId: 'writer', patch: { model: null, effort: null } }).success).toBe(true);
        expect(MachineDelegationRolesRequestSchema.safeParse({ action: 'update', roleId: 'writer', patch: { id: 'another-id' } }).success).toBe(false);
        expect(MachineDelegationRolesRequestSchema.safeParse({ action: 'update', roleId: 'writer', patch: {} }).success).toBe(false);
        expect(MachineDelegationRolesRequestSchema.safeParse({ action: 'list', parentSessionId: 'spoof' }).success).toBe(false);
        expect(MachineDelegationRolesRequestSchema.safeParse({ action: 'start', roleId: 'writer', prompt: 'Run' }).success).toBe(false);
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
