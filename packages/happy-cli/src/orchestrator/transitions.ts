/**
 * Step transitions for the AX Studio step workflow. These are the mutating
 * operations the web UI drives via RPC.
 *
 * `applyTransition`           — moves `state.step`, appends to `history`,
 *                                emits `step.transition` event, no-ops when
 *                                the requested step equals current.
 *
 * Per-step write boundaries are no longer enforced (PreToolUse hook removed
 * in specs/20260522-ax-step-free-mode). `work.permissions` is gone with it.
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
