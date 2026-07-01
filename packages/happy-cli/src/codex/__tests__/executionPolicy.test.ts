import { describe, expect, it } from 'vitest';
import { resolveCodexExecutionPolicy, shouldAutoApproveCodexApproval } from '../executionPolicy';

describe('resolveCodexExecutionPolicy', () => {
    it('forces never + danger-full-access when sandbox is managed by Happy', () => {
        const policy = resolveCodexExecutionPolicy('default', true);

        expect(policy).toEqual({
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });
    });

    it('maps codex default mode to untrusted + workspace-write without managed sandbox', () => {
        const policy = resolveCodexExecutionPolicy('default', false);

        expect(policy).toEqual({
            approvalPolicy: 'untrusted',
            sandbox: 'workspace-write',
        });
    });

    it('maps read-only mode to never + read-only without managed sandbox', () => {
        const policy = resolveCodexExecutionPolicy('read-only', false);

        expect(policy).toEqual({
            approvalPolicy: 'never',
            sandbox: 'read-only',
        });
    });

    it('maps safe-yolo mode to never + workspace-write without managed sandbox', () => {
        const policy = resolveCodexExecutionPolicy('safe-yolo', false);

        expect(policy).toEqual({
            approvalPolicy: 'never',
            sandbox: 'workspace-write',
        });
    });

    it('maps yolo mode to never + danger-full-access without managed sandbox', () => {
        const policy = resolveCodexExecutionPolicy('yolo', false);

        expect(policy).toEqual({
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });
    });

    it('maps bypassPermissions mode to never + danger-full-access without managed sandbox', () => {
        const policy = resolveCodexExecutionPolicy('bypassPermissions', false);

        expect(policy).toEqual({
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
        });
    });

    it('auto-approves bridge prompts for no-prompt modes without managed sandbox', () => {
        expect(shouldAutoApproveCodexApproval('default', false)).toBe(false);
        expect(shouldAutoApproveCodexApproval('read-only', false)).toBe(false);
        expect(shouldAutoApproveCodexApproval('safe-yolo', false)).toBe(true);
        expect(shouldAutoApproveCodexApproval('yolo', false)).toBe(true);
        expect(shouldAutoApproveCodexApproval('bypassPermissions', false)).toBe(true);
    });

    it('auto-approves bridge prompts when Happy owns sandboxing', () => {
        expect(shouldAutoApproveCodexApproval('default', true)).toBe(true);
        expect(shouldAutoApproveCodexApproval('read-only', true)).toBe(true);
        expect(shouldAutoApproveCodexApproval('safe-yolo', true)).toBe(true);
    });
});
