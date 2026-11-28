import * as React from 'react';
import type { AntigravityModelCatalog } from '@slopus/happy-wire';
import { machineGetAntigravityModelCatalog } from '@/sync/ops';
import { getFirstSubmissionScope, subscribeFirstSubmissionScope } from '@/sync/firstSubmissionScope';

/** Selection and explicit refresh are the only triggers; replies belong to one account and launch directory. */
export function useAntigravityModelCatalog(args: {
    machineId: string | null;
    directory: string | null;
    enabled: boolean;
}) {
    const { machineId, directory, enabled } = args;
    const account = React.useSyncExternalStore(
        subscribeFirstSubmissionScope,
        getFirstSubmissionScope,
        getFirstSubmissionScope,
    );
    const scope = React.useMemo(
        () => (enabled && machineId && directory ? { machineId, directory, account } : null),
        [enabled, machineId, directory, account],
    );
    const active = React.useRef(scope);
    active.current = scope;
    const mounted = React.useRef(true);
    React.useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);
    const [state, setState] = React.useState<{
        scope: typeof scope;
        catalog: AntigravityModelCatalog | null;
        loading: boolean;
        error: boolean;
    }>({ scope: null, catalog: null, loading: false, error: false });
    const pending = React.useRef<{ scope: NonNullable<typeof scope>; promise: Promise<void> } | null>(null);
    const refresh = React.useCallback((): Promise<void> => {
        if (!scope) return Promise.reject(new Error('Antigravity model catalog is unavailable'));
        if (pending.current?.scope === scope) return pending.current.promise;
        const current = () =>
            mounted.current && active.current === scope && getFirstSubmissionScope() === scope.account;
        setState((previous) => ({
            scope,
            catalog: previous.scope === scope ? previous.catalog : null,
            loading: true,
            error: false,
        }));
        const promise = machineGetAntigravityModelCatalog(scope.machineId, scope.directory)
            .then((catalog) => {
                if (current()) setState({ scope, catalog, loading: false, error: false });
            })
            .catch((error) => {
                if (current())
                    setState((previous) => ({
                        scope,
                        catalog: previous.scope === scope ? previous.catalog : null,
                        loading: false,
                        error: true,
                    }));
                throw error;
            })
            .finally(() => {
                if (pending.current?.promise === promise) pending.current = null;
            });
        pending.current = { scope, promise };
        return promise;
    }, [scope]);
    React.useEffect(() => {
        if (scope)
            void refresh().catch(() => {
                /* Failure is exposed for explicit retry. */
            });
    }, [scope, refresh]);
    return {
        catalog: scope && state.scope === scope ? state.catalog : null,
        loading: !!scope && (state.scope !== scope || state.loading),
        error: state.scope === scope && state.error,
        refresh,
    };
}
