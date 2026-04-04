import { RpcHandlerManager } from "@/api/rpc/RpcHandlerManager";
import { logger } from "@/lib";
import { Session } from "./session";

interface ResumeSessionRequest {
    // No parameters needed
}

interface ResumeSessionResponse {
    success: boolean;
    message: string;
}

export function registerResumeSessionHandler(
    rpcHandlerManager: RpcHandlerManager,
    session: Session,
    abortCurrentSession: () => Promise<void>
) {
    rpcHandlerManager.registerHandler<ResumeSessionRequest, ResumeSessionResponse>('resumeSession', async () => {
        logger.debug('[resumeSession] Resume session request received');

        const result = session.requestResume();
        if (!result.success) {
            return result;
        }

        // Abort the current Claude process so the loop restarts with --resume
        await abortCurrentSession();

        return {
            success: true,
            message: 'Session resume initiated'
        };
    });
}
