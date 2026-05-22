/**
 * Registers AX Studio step workflow RPC handlers on a session.
 *
 * Endpoints (matched by name on the websocket RPC manager):
 *   - `ax:bootstrap`   → `{ step?: AxStep }` → idempotent provisioning
 *   - `ax:get-state`   → returns `{ state | null }` for this workspace
 *   - `ax:transition`  → `{ to: AxStep }` → applies + returns new state
 *
 * The web UI calls these via happy-server's RPC forwarding; the server is a
 * pass-through, no FS knowledge needed.
 *
 * Note: `ax:permission` removed in specs/20260522-ax-step-free-mode along
 * with PreToolUse hook + `work.permissions` field.
 */

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { logger } from '@/ui/logger';
import { AxState, AxStep, AxStepSchema } from './state/schema';
import { readState } from './state/io';
import { StateFileCorruptError } from './state/io';
import { bootstrapWorkspace } from './state/bootstrap';
import { applyTransition } from './transitions';

interface GetStateResponse {
    state: AxState | null;
    error?: string;
}

interface TransitionRequest {
    to: AxStep;
}

interface TransitionResponse {
    state: AxState;
}

export function registerAxRpcHandlers(manager: RpcHandlerManager, workspaceRoot: string): void {
    manager.registerHandler<{ step?: AxStep }, GetStateResponse>('ax:bootstrap', async (req) => {
        const step = AxStepSchema.parse(req?.step ?? 'plan');
        logger.debug(`[ax] bootstrap requested → step=${step}`);
        await bootstrapWorkspace(workspaceRoot, step);
        const state = await readState(workspaceRoot);
        return { state };
    });

    manager.registerHandler<unknown, GetStateResponse>('ax:get-state', async () => {
        try {
            const state = await readState(workspaceRoot);
            return { state };
        } catch (err) {
            if (err instanceof StateFileCorruptError) {
                return { state: null, error: err.message };
            }
            return { state: null };
        }
    });

    manager.registerHandler<TransitionRequest, TransitionResponse>('ax:transition', async (req) => {
        const to = AxStepSchema.parse(req?.to);
        logger.debug(`[ax] transition requested → ${to}`);
        const state = await applyTransition(workspaceRoot, to);
        return { state };
    });
}
