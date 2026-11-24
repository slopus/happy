import { expect, it } from 'vitest';
import { scheduledLaunchPermission, assertScheduledRuntimeSupported } from './permissions';
import { resolveCodexExecutionPolicy, isRemoteCodexPermissionMode } from '@/codex/executionPolicy';
import { mapToClaudeMode } from '@/claude/utils/permissionMode';

it('enforces a read-only Codex policy for scheduled plan mode instead of falling back to yolo', () => {
    const mode = scheduledLaunchPermission('codex', { HAPPY_SCHEDULED_PERMISSION_MODE: 'plan' });
    expect(isRemoteCodexPermissionMode(mode)).toBe(true);
    expect(resolveCodexExecutionPolicy(mode!, false)).toEqual({ approvalPolicy: 'never', sandbox: 'read-only' });
});
it('uses Claude plan mode for read-only work and refuses a runtime that forces bypass', () => {
    expect(mapToClaudeMode(scheduledLaunchPermission('claude', { HAPPY_SCHEDULED_PERMISSION_MODE: 'read-only' })!)).toBe('plan');
    expect(() => assertScheduledRuntimeSupported(true)).toThrow('scheduled-sandbox-unsupported');
    expect(() => scheduledLaunchPermission('codex', { HAPPY_SCHEDULED_PERMISSION_MODE: 'yolo' })).toThrow();
});
