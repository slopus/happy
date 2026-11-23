import * as React from 'react';
import type { CodexMagpieCatalog } from '@slopus/happy-wire';
import { machineGetMagpieModelCatalog } from '@/sync/ops';
import { getFirstSubmissionScope, subscribeFirstSubmissionScope } from '@/sync/firstSubmissionScope';

export function useMagpieModelCatalog(machineId: string | null, directory: string | null, enabled: boolean) {
    const account = React.useSyncExternalStore(subscribeFirstSubmissionScope, getFirstSubmissionScope, getFirstSubmissionScope);
    const scope = React.useMemo(() => ({ account, machineId, directory }), [account, machineId, directory]);
    const active = React.useRef<typeof scope | null>(scope);
    active.current = scope;
    React.useEffect(() => { active.current = scope; return () => { active.current = null; }; }, [scope]);
    const [state, setState] = React.useState<{ scope: typeof scope; catalog: CodexMagpieCatalog | null }>();
    const pending = React.useRef<{ scope: typeof scope; promise: Promise<void> } | null>(null);
    const refresh = React.useCallback(() => {
        if (!enabled || !scope.account || !scope.machineId || !scope.directory) return Promise.resolve();
        if (pending.current?.scope === scope) return pending.current.promise;
        const promise = machineGetMagpieModelCatalog(scope.machineId, scope.directory).then(catalog => {
            if (active.current === scope && getFirstSubmissionScope() === scope.account) setState({ scope, catalog });
        }).finally(() => {
            if (pending.current?.promise === promise) pending.current = null;
        });
        pending.current = { scope, promise };
        return promise;
    }, [scope, enabled]);
    return { catalog: state?.scope === scope ? state.catalog : null, refresh };
}
