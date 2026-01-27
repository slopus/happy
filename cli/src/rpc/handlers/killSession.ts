import { RpcHandlerManager } from "@/api/rpc/RpcHandlerManager";
import { logger } from "@/lib";
import { RPC_METHODS } from '@happy/protocol/rpc';

interface KillSessionRequest {
    // No parameters needed
}

interface KillSessionResponse {
    success: boolean;
    message: string;
}


export function registerKillSessionHandler(
    rpcHandlerManager: RpcHandlerManager,
    killThisHappy: () => Promise<void>
) {
    rpcHandlerManager.registerHandler<KillSessionRequest, KillSessionResponse>(RPC_METHODS.KILL_SESSION, async () => {
        logger.debug('Kill session request received');

        // This will start the cleanup process
        void killThisHappy();

        // We should still be able to respond the the client, though they
        // should optimistically assume the session is dead.
        return {
            success: true,
            message: 'Killing happy-cli process'
        };
    });
}
