import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { checkpointAgentSchemas, type CheckpointAgentReader, type CheckpointAgentOperation } from './checkpointAgentReader';

/** Session-scoped MCP reads; admission stays with the host that owns shutdown. */
export function registerCheckpointAgentTools(mcp: McpServer, reader: CheckpointAgentReader,
    runTool: <T>(work: () => Promise<T>) => Promise<T | { isError: boolean; content: { type: 'text'; text: string }[] }>) {
    const descriptions: Record<CheckpointAgentOperation, string> = {
        status: 'Check whether this session supports and currently enables automatic local file history. Check before reading records; inactive/unknown is not success. Read-only; cannot enable recording or restore files.',
        list: 'List this session’s file checkpoints, newest first. Up to 50 records per page; follow nextOffset. Requires checkpoint_status enabled. Read-only; no other session identity or store path is accepted.',
        preview: 'Read changed-file candidates for a checkpoint from checkpoint_list. Up to 100 files per page; follow nextOffset. Skipped/conflicting files are not safe automatic restore targets. This preview does not authorize restoration; use Desktop preview and explicit user confirmation.',
        diff: 'Compare one project-relative file’s current contents to a checkpoint from checkpoint_list (current → selected record restoration direction). Read-only, at most 500 lines/64KiB with a truncated flag. Binary, excluded and unrecorded files may be unavailable. Does not restore files.',
    };
    for (const operation of Object.keys(checkpointAgentSchemas) as CheckpointAgentOperation[]) {
        mcp.registerTool(`checkpoint_${operation}`, {
            title: `File checkpoint ${operation}`, description: descriptions[operation],
            inputSchema: checkpointAgentSchemas[operation],
            annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        }, async (params: unknown) => runTool(async () => {
            try {
                return { content: [{ type: 'text' as const, text: JSON.stringify(await reader.query(operation, params)) }] };
            } catch (error) {
                const code = error instanceof Error && error.message === 'CHECKPOINT_UNAVAILABLE' ? error.message : 'CHECKPOINT_READ_FAILED';
                return { isError: true, content: [{ type: 'text' as const, text: code }] };
            }
        }));
    }
}
