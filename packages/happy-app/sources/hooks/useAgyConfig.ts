import { accountRuntimeCurrent } from '@/auth/accountRuntime';
import { beginAgyConfig, finishAgyConfig, isAgyConfigPending, subscribeAgyConfig } from '@/sync/agyConfigPending';
import * as React from 'react';
import { sessionSetAgyConfig } from '@/sync/ops';
import { storage } from '@/sync/storage';
import { Modal } from '@/modal';
import { t } from '@/text';

/** Both running-session pickers share the same acknowledged ACP update path. */
export function useAgyConfig(sessionId: string, flavor: string | null | undefined) {
    const busy = React.useSyncExternalStore(subscribeAgyConfig, () => isAgyConfigPending(sessionId), () => false);
    const owner = React.useRef<string | null>(sessionId);
    owner.current = sessionId;
    React.useEffect(() => {
        owner.current = sessionId;
        return () => { owner.current = null; };
    }, [sessionId]);
    const apply = React.useCallback(async (request: { model?: string; effort?: string }) => {
        if (flavor !== 'antigravity') return false;
        if (!beginAgyConfig(sessionId)) return true;
        const workerPid = storage.getState().sessions[sessionId]?.metadata?.hostPid;
        try {
            const result = await sessionSetAgyConfig(sessionId, request);
            const target = storage.getState().sessions[sessionId];
            if (!accountRuntimeCurrent() || target?.metadata?.flavor !== 'antigravity' || target.metadata.hostPid !== workerPid) return true;
            storage.getState().updateSessionModelMode(sessionId, result.model);
            storage.getState().updateSessionEffortLevel(sessionId, result.effort);
        } catch (error) {
            if (owner.current === sessionId) Modal.alert(t('common.error'), error instanceof Error ? error.message : String(error));
        } finally {
            finishAgyConfig(sessionId);
        }
        return true;
    }, [sessionId, flavor]);
    return { apply, busy };
}
