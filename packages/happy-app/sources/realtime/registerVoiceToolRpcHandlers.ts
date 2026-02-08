import { apiSocket } from '@/sync/apiSocket';
import { realtimeClientTools } from './realtimeClientTools';
import { setCurrentRealtimeSessionId } from './RealtimeSession';

type ToolName = keyof typeof realtimeClientTools;

const VOICE_RPC_PREFIX = 'voice-tool:';

let cleanupFns: Array<() => void> = [];
let registered = false;

export function registerVoiceToolRpcHandlers() {
    if (registered) {
        return () => {};
    }

    registered = true;
    cleanupFns = [];

    const toolNames = Object.keys(realtimeClientTools) as ToolName[];
    for (const toolName of toolNames) {
        const method = `${VOICE_RPC_PREFIX}${toolName}`;
        const unregister = apiSocket.registerRpcHandler(method, async (payload: any) => {
            try {
                const appSessionId = payload?.appSessionId as string | undefined;
                if (appSessionId) {
                    setCurrentRealtimeSessionId(appSessionId);
                }

                const parameters = payload?.parameters ?? payload ?? {};
                const toolFn = realtimeClientTools[toolName] as (params: unknown) => Promise<string>;
                const result = await toolFn(parameters);
                return { result };
            } catch (error) {
                return {
                    result: `error (${error instanceof Error ? error.message : 'unknown'})`,
                };
            }
        });
        cleanupFns.push(unregister);
    }

    return () => {
        for (const cleanup of cleanupFns) {
            cleanup();
        }
        cleanupFns = [];
        registered = false;
    };
}
