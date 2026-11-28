import { describe, expect, it, vi } from 'vitest';
import { applyCodexRpcPermissionMode } from './runCodex';
import type { PermissionMode } from '@/api/types';

describe('ordinary Codex permission RPC acceptance', () => {
    it.each([false, true])('rejects historical automatic before applying or acknowledging it (managed sandbox=%s)', managed => {
        let mode: PermissionMode = 'acceptEdits';
        const apply = vi.fn((value: PermissionMode) => { mode = value; });
        expect(() => applyCodexRpcPermissionMode('safe-yolo', managed, apply)).toThrow(/automatic approval.*not supported/i);
        expect(mode).toBe('acceptEdits'); expect(apply).not.toHaveBeenCalled();
    });

    it.each(['read-only', 'acceptEdits', 'yolo', 'default'] as const)('continues to accept the supported %s mode exactly once', mode => {
        const apply = vi.fn();
        expect(applyCodexRpcPermissionMode(mode, false, apply)).toBe(true);
        expect(apply).toHaveBeenCalledExactlyOnceWith(mode);
    });

    it.each([undefined, null, 42, {}, 'invalid-permission-mode'])('does not apply an unrecognized RPC value %j', mode => {
        const apply = vi.fn();
        expect(applyCodexRpcPermissionMode(mode, false, apply)).toBe(false);
        expect(apply).not.toHaveBeenCalled();
    });
});
