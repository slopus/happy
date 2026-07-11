import { RpcHandlerManager } from './RpcHandlerManager';
import { logger } from '@/ui/logger';

interface ChangeTitleRequest {
    title: string;
}

interface ChangeTitleResponse {
    success: boolean;
    error?: string;
}

/**
 * Registers the `changeTitle` session RPC used by the app to rename a chat.
 *
 * The rename is written through the same Claude `summary` record used by the
 * `change_title` MCP tool (see {@link ApiSessionClient.changeTitle}), so a
 * user-driven rename updates the underlying Claude Code session name and
 * propagates to the Happy session metadata exactly like an agent-driven title
 * change. Registered for every session flavor because a `summary` message only
 * updates `metadata.summary` and produces no Claude-specific protocol messages.
 */
export function registerChangeTitleHandler(
    rpcHandlerManager: RpcHandlerManager,
    changeTitle: (title: string) => void,
) {
    rpcHandlerManager.registerHandler<ChangeTitleRequest, ChangeTitleResponse>('changeTitle', async (request) => {
        const title = typeof request?.title === 'string' ? request.title.trim() : '';
        if (!title) {
            return { success: false, error: 'Title must be a non-empty string' };
        }

        logger.debug('[changeTitle] Renaming session to:', title);
        changeTitle(title);
        return { success: true };
    });
}
