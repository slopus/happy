/**
 * Step transitions and permission decisions for the start-from-planning
 * workflow. These are the mutating operations the web UI drives via RPC.
 *
 * `applyTransition`           — moves `state.step`, appends to `history`,
 *                                emits `step.transition` event, no-ops when
 *                                the requested step equals current.
 * `applyPermissionDecision`   — records the user's modal response. Only
 *                                `always` / `never` mutate `permissions.*`;
 *                                `once` / `deny` are turn-scoped (event only).
 */

import { randomUUID } from 'node:crypto';
import { AxState, AxStep } from './state/schema';
import { readState, writeState, appendEvent } from './state/io';

export async function applyTransition(workspaceRoot: string, to: AxStep): Promise<AxState> {
    const current = await readState(workspaceRoot);
    if (current.step === to) return current;

    const now = new Date().toISOString();
    const next: AxState = {
        ...current,
        step: to,
        history: [...current.history, { from: current.step, to, at: now }],
    };
    if (to === 'work' && next.work.startedAt === null) {
        next.work = { ...next.work, startedAt: now };
    }
    await writeState(workspaceRoot, next);
    await appendEvent(workspaceRoot, {
        id: `evt_${randomUUID()}`,
        at: now,
        type: 'step.transition',
        payload: { from: current.step, to },
    });
    return next;
}

export type PermissionTarget = 'editPlanMd' | 'editDesignMd';
export type PermissionDecisionKind = 'once' | 'always' | 'deny' | 'never';

export async function applyPermissionDecision(
    workspaceRoot: string,
    target: PermissionTarget,
    decision: PermissionDecisionKind,
): Promise<AxState> {
    const current = await readState(workspaceRoot);
    let next = current;
    if (decision === 'always' || decision === 'never') {
        next = {
            ...current,
            work: {
                ...current.work,
                permissions: { ...current.work.permissions, [target]: decision },
            },
        };
        await writeState(workspaceRoot, next);
    }
    await appendEvent(workspaceRoot, {
        id: `evt_${randomUUID()}`,
        at: new Date().toISOString(),
        type: 'permission.decision',
        payload: { target, decision },
    });
    return next;
}
