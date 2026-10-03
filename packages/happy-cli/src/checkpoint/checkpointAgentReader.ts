import { realpath } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import type { SandboxConfig } from '@/persistence';
import type { CheckpointProvider } from './checkpointExclusionPolicy';
import { readCheckpointSpawnContext } from './checkpointSpawnContext';
import { resolveCheckpointLocalHistoryCapability, LOCAL_HISTORY_ALWAYS_EXCLUDED } from './checkpointLocalHistory';
import { CheckpointProtectionStateStore } from './checkpointProtectionState';
import { createCheckpointRpcHandlers, type CheckpointRpcSessionAuthority } from './checkpointRpc';

const checkpointId = z.string().regex(/^[a-f0-9]{40,64}$/);
const page = { offset: z.number().int().min(0).max(1_000_000).optional() };
export const checkpointAgentSchemas = {
    status: z.object({}).strict(),
    list: z.object({ ...page, limit: z.number().int().min(1).max(50).optional() }).strict(),
    preview: z.object({ ...page, checkpointId, limit: z.number().int().min(1).max(100).optional() }).strict(),
    diff: z.object({ checkpointId, path: z.string().min(1).max(4096) }).strict(),
};
export type CheckpointAgentOperation = keyof typeof checkpointAgentSchemas;
const listResult = z.object({ checkpoints: z.array(z.object({ checkpointId, createdAt: z.number().finite() })) });
const previewResult = z.object({ entries: z.array(z.object({ path: z.string(), action: z.enum(['restore', 'delete', 'skip', 'conflict']), reason: z.string() })),
    skipDetails: z.array(z.object({ path: z.string(), detail: z.string() })).optional() });
const diffResult = z.object({ status: z.enum(['text', 'binary', 'too-large']), diff: z.string() });
type Page = { schemaVersion: 1; total: number; nextOffset: number | null };
type ReadResults = {
    status: { schemaVersion: 1; supported: boolean; enabled: boolean; mode: 'local-history'; reason?: string; restoreRequiresUserConfirmation: true };
    list: Page & z.infer<typeof listResult>;
    preview: Page & z.infer<typeof previewResult> & { checkpointId: string; restoreRequiresUserConfirmation: true };
    diff: z.infer<typeof diffResult> & { schemaVersion: 1; checkpointId: string; path: string; direction: 'current-to-checkpoint'; truncated: boolean };
};
const GUIDANCE = 'Local file history is enabled for this session and records automatically before and after each turn. Use mcp__happy__checkpoint_status to check current availability, checkpoint_list to find records, checkpoint_preview to find changed files, and checkpoint_diff for read-only current-to-record comparisons when diagnosing changes or proposing a rollback. History may exclude files and returned pages/diffs may be truncated; inspect the response metadata. Restoring files requires the Desktop preview and the user’s explicit confirmation; these tools do not restore or create records.';

/** Immutable launcher binding, current persisted state, and existing RPC ownership/coverage checks. */
export function createCheckpointAgentReader(input: {
    provider: CheckpointProvider; platform: NodeJS.Platform; projectPath: string; sessionId: string;
    sandboxConfig?: SandboxConfig; env: Record<string, string | undefined>;
}) {
    const canonicalProjectPath = realpath(input.projectPath).catch(() => null);
    const context = readCheckpointSpawnContext(input.env);
    const capability = resolveCheckpointLocalHistoryCapability(input);
    const patterns = input.sandboxConfig?.checkpointProtection ? [...input.sandboxConfig.checkpointProtection.secretPatterns, ...LOCAL_HISTORY_ALWAYS_EXCLUDED] : null;
    const binding = context ? { sessionId: input.sessionId, projectId: context.projectId, worktreeId: context.worktreeId } : null;
    async function authority(): Promise<CheckpointRpcSessionAuthority | null> {
        if (!capability.supported || !context || !binding || !patterns) return null;
        const projectPath = await canonicalProjectPath;
        if (!projectPath) throw new Error('CHECKPOINT_STATE_UNAVAILABLE');
        const state = await new CheckpointProtectionStateStore(context.checkpointRoot).read({ ...binding, projectPath });
        if (state.protection.status !== 'protected') return null;
        return { ...binding, projectPath, protection: state.protection, pendingDecision: state.pendingDecision,
            mode: 'local-history', excludedPaths: [], excludedPatterns: patterns };
    }
    async function status(): Promise<ReadResults['status']> {
        let enabled = false;
        let reason: string | undefined = !capability.supported ? capability.reason
            : !context ? 'session-context-unavailable' : !patterns ? 'disabled' : undefined;
        if (!reason) {
            try { enabled = Boolean(await authority()); if (!enabled) reason = 'disabled'; }
            catch { reason = 'state-unavailable'; }
        }
        return { schemaVersion: 1, supported: capability.supported, enabled, mode: 'local-history',
            restoreRequiresUserConfirmation: true, ...(reason ? { reason } : {}) };
    }
    const rpc = context ? createCheckpointRpcHandlers({ checkpointRoot: context.checkpointRoot,
        resolveAuthority: async sessionId => binding?.sessionId === sessionId ? authority() : null,
        resolveEventPublisher: async () => null,
        restartSession: async () => { throw new Error('CHECKPOINT_READ_ONLY'); },
    }) : null;
    async function query<O extends CheckpointAgentOperation>(operation: O, params: unknown): Promise<ReadResults[O]> {
        if (!Object.prototype.hasOwnProperty.call(checkpointAgentSchemas, operation)) throw new Error('CHECKPOINT_INVALID_REQUEST');
        const request = checkpointAgentSchemas[operation].parse(params);
        if (operation === 'status') return await status() as ReadResults[O];
        if (!(await status()).enabled || !rpc || !binding) throw new Error('CHECKPOINT_UNAVAILABLE');
        const base = { schemaVersion: 1, ...binding };
        let result: ReadResults[CheckpointAgentOperation];
        if (operation === 'list') {
            const args = checkpointAgentSchemas.list.parse(request);
            const history = listResult.parse(await rpc.list(base)).checkpoints;
            const offset = args.offset ?? 0, limit = args.limit ?? 50;
            result = { ...pageInfo(history.length, offset, limit), checkpoints: history.slice(offset, offset + limit) };
        } else if (operation === 'preview') {
            const args = checkpointAgentSchemas.preview.parse(request);
            const plan = previewResult.parse(await rpc.preview({ ...base, checkpointId: args.checkpointId }));
            const hidden = new Set(plan.skipDetails?.filter(item => item.detail === 'not-recorded').map(item => item.path));
            const entries = plan.entries.filter(item => !hidden.has(item.path));
            const offset = args.offset ?? 0, limit = args.limit ?? 100;
            const selected = entries.slice(offset, offset + limit), paths = new Set(selected.map(item => item.path));
            result = { ...pageInfo(entries.length, offset, limit), checkpointId: args.checkpointId, entries: selected,
                skipDetails: plan.skipDetails?.filter(item => paths.has(item.path)), restoreRequiresUserConfirmation: true };
        } else {
            const args = checkpointAgentSchemas.diff.parse(request);
            const raw = diffResult.parse(await rpc.diff!({ ...base, ...args }));
            const lines = raw.diff.split('\n', 501);
            const clipped = lines.slice(0, 500).join('\n');
            const bytes = Buffer.from(clipped);
            result = { schemaVersion: 1, ...args, status: raw.status, direction: 'current-to-checkpoint',
                diff: new StringDecoder('utf8').write(bytes.subarray(0, 65536)), truncated: lines.length > 500 || bytes.length > 65536 };
        }
        return result as ReadResults[O];
    }
    return { status, query, guidance: async () => (await status()).enabled ? GUIDANCE : '' };
}
export type CheckpointAgentReader = ReturnType<typeof createCheckpointAgentReader>;
function pageInfo(total: number, offset: number, limit: number): Page {
    return { schemaVersion: 1, total, nextOffset: offset + limit < total ? offset + limit : null };
}
