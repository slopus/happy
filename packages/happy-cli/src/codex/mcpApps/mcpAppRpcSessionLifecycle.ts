import type { McpAppRpcHandlerManager } from './registerMcpAppRpcHandlers';

type McpAppRpcRegistration = {
    rebind(manager: McpAppRpcHandlerManager): void;
};

type SessionWithRpcHandlers = {
    rpcHandlerManager: McpAppRpcHandlerManager;
};

/** Keeps session-scoped resource handlers attached across offline reconnects. */
export function rebindMcpAppRpcHandlersOnSessionSwap(
    registration: McpAppRpcRegistration | null,
    session: SessionWithRpcHandlers,
): void {
    registration?.rebind(session.rpcHandlerManager);
}
