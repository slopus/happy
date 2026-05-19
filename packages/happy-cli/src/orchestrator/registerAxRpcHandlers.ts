/**
 * Registers AX Studio start-from-planning RPC handlers on a session.
 *
 * Endpoints (matched by name on the websocket RPC manager):
 *   - `ax:get-state`   → returns `{ state | null }` for this workspace
 *   - `ax:transition`  → `{ to: AxStep }` → applies + returns new state
 *   - `ax:permission`  → `{ target, decision }` → records modal response
 *
 * The web UI calls these via happy-server's RPC forwarding; the server is a
 * pass-through, no FS knowledge needed.
 */

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { logger } from '@/ui/logger';
import { AxState, AxStep, AxStepSchema } from './state/schema';
import { readState } from './state/io';
import { StateFileCorruptError } from './state/io';
import { bootstrapWorkspace } from './state/bootstrap';
import {
    applyTransition,
    applyPermissionDecision,
    PermissionDecisionKind,
    PermissionTarget,
} from './transitions';

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

interface PermissionRequest {
    target: PermissionTarget;
    decision: PermissionDecisionKind;
}

interface PermissionResponse {
    state: AxState;
}

const PERMISSION_TARGETS: ReadonlySet<PermissionTarget> = new Set(['editPlanMd', 'editDesignMd']);
const PERMISSION_DECISIONS: ReadonlySet<PermissionDecisionKind> = new Set([
    'once',
    'always',
    'deny',
    'never',
]);

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

    manager.registerHandler<PermissionRequest, PermissionResponse>('ax:permission', async (req) => {
        if (!req || !PERMISSION_TARGETS.has(req.target)) {
            throw new Error(`Invalid permission target: ${String(req?.target)}`);
        }
        if (!PERMISSION_DECISIONS.has(req.decision)) {
            throw new Error(`Invalid permission decision: ${String(req?.decision)}`);
        }
        logger.debug(`[ax] permission decision: ${req.target} = ${req.decision}`);
        const state = await applyPermissionDecision(workspaceRoot, req.target, req.decision);
        return { state };
    });
}
