import * as React from 'react';
import { storage } from '@/sync/storage';
import type { Session } from '@/sync/storageTypes';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { isProjectSessionDeleted } from '@/sync/projectSessionLinks';

/** A machine-verified history link can enter SessionView's normal loading and
 * recovery flow. Explicit live ownership always overrides an old history link. */
export function useProjectConversation(id: string | undefined, known: boolean, accepts: (metadata: NonNullable<Session['metadata']>) => boolean) {
    const session = storage(state => id ? state.sessions[id] : undefined);
    const rejected = !!id && (isProjectSessionDeleted(id) || (!!session?.metadata && !accepts(session.metadata)));
    const verified = !!id && !rejected && (known || !!session?.metadata);
    const [attempt, retry] = React.useReducer(value => value + 1, 0);
    const [failure, setFailure] = React.useState<{ id: string; attempt: number }>();
    React.useEffect(() => {
        if (!id || verified || rejected) return;
        let current = true;
        setFailure(undefined);
        // This one-shot check is only for an unassociated URL. Trusted history
        // uses SessionView, which owns connection readiness, retries and errors.
        void sync.ensureSessionHydrated(id).then(ready => {
            if (current && (!ready || !storage.getState().sessions[id]?.metadata)) setFailure({ id, attempt });
        }).catch(() => { if (current) setFailure({ id, attempt }); });
        return () => { current = false; };
    }, [id, verified, rejected, attempt]);
    return { verified, rejected, error: !verified && failure?.id === id && failure?.attempt === attempt ? t('projectGoals.sessionUnavailable') : null, retry };
}
