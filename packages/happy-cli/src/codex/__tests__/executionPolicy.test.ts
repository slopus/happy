import { describe, expect, it } from 'vitest';
import { resolveCodexExecutionPolicy } from '../executionPolicy';

describe('resolveCodexExecutionPolicy', () => {
    it('maps codex default mode to untrusted + workspace-write', () => {
        const policy = resolveCodexExecutionPolicy('default');

        expect(policy).toEqual({
            approvalPolicy: 'untrusted',
            sandbox: 'workspace-write',
        });
    });

    it('maps read-only mode to never + read-only', () => {
        const policy = resolveCodexExecutionPolicy('read-only');

        expect(policy).toEqual({
            approvalPolicy: 'never',
            sandbox: 'read-only',
        });
    });
});
