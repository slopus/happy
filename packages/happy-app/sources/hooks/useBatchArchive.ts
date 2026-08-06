/**
 * Batch archive for the session list's selection mode.
 *
 * Mirrors the single-session archive flow in useSessionQuickActions
 * (kill the CLI process; if it's already dead, archive via server),
 * but runs over many sessions sequentially so progress can be shown,
 * and skips the interactive worktree-cleanup prompt — batch operations
 * must never block on a dialog per session.
 */

import * as React from 'react';
import { sessionKill, sessionArchive } from '@/sync/ops';
import { sync } from '@/sync/sync';

export interface BatchArchiveState {
    running: boolean;
    done: number;
    total: number;
}

const IDLE: BatchArchiveState = { running: false, done: 0, total: 0 };

export function useBatchArchive(
    onComplete: (ok: number, failed: number) => void,
): [BatchArchiveState, (sessionIds: string[]) => Promise<void>] {
    const [state, setState] = React.useState<BatchArchiveState>(IDLE);
    const onCompleteRef = React.useRef(onComplete);
    onCompleteRef.current = onComplete;

    const run = React.useCallback(async (sessionIds: string[]) => {
        if (sessionIds.length === 0) return;
        setState({ running: true, done: 0, total: sessionIds.length });
        let ok = 0;
        let failed = 0;
        for (const sessionId of sessionIds) {
            try {
                const killResult = await sessionKill(sessionId);
                if (!killResult.success) {
                    const archiveResult = await sessionArchive(sessionId);
                    if (archiveResult.success) ok += 1;
                    else failed += 1;
                } else {
                    ok += 1;
                }
            } catch {
                failed += 1;
            }
            setState(prev => ({ ...prev, done: prev.done + 1 }));
        }
        await sync.refreshSessions();
        setState(IDLE);
        onCompleteRef.current(ok, failed);
    }, []);

    return [state, run];
}
