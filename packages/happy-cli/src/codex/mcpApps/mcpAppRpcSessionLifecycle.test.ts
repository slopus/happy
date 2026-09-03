import { describe, expect, it, vi } from 'vitest';
import { rebindMcpAppRpcHandlersOnSessionSwap } from './mcpAppRpcSessionLifecycle';

describe('rebindMcpAppRpcHandlersOnSessionSwap', () => {
    it('moves the active App resource handlers to the replacement session manager', () => {
        const rebind = vi.fn();
        const replacementManager = { registerHandler: vi.fn(), unregisterHandler: vi.fn() };

        rebindMcpAppRpcHandlersOnSessionSwap({ rebind }, {
            rpcHandlerManager: replacementManager,
        });

        expect(rebind).toHaveBeenCalledOnce();
        expect(rebind).toHaveBeenCalledWith(replacementManager);
    });

    it('allows a reconnect that happens before resource handlers are initialized', () => {
        expect(() => rebindMcpAppRpcHandlersOnSessionSwap(null, {
            rpcHandlerManager: { registerHandler: vi.fn(), unregisterHandler: vi.fn() },
        })).not.toThrow();
    });
});
