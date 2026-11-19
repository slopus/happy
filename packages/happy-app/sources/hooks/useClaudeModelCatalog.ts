import * as React from 'react';
import type { ClaudeModelCatalog } from '@slopus/happy-wire';
import { machineGetClaudeModelCatalog } from '@/sync/ops';

export function useClaudeModelCatalog(args: { machineId: string | null; directory: string | null; enabled: boolean }) {
    const { machineId, directory, enabled } = args;
    const scope = enabled && machineId && directory ? JSON.stringify([machineId, directory]) : null;
    const activeScope = React.useRef({ scope, epoch: 0 });
    if (activeScope.current.scope !== scope) activeScope.current = { scope, epoch: activeScope.current.epoch + 1 };
    const epoch = activeScope.current.epoch;
    const mounted = React.useRef(true);
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const [state, setState] = React.useState<{ scope: string | null; catalog: ClaudeModelCatalog | null; error: boolean }>({ scope: null, catalog: null, error: false });
    const pending = React.useRef<{ scope: string; epoch: number; promise: Promise<void> } | null>(null);
    const refresh = React.useCallback((): Promise<void> => {
        if (!scope || !machineId || !directory) return Promise.reject(new Error('Claude model catalog is unavailable'));
        if (pending.current?.scope === scope && pending.current.epoch === epoch) return pending.current.promise;
        const current = () => mounted.current && activeScope.current.scope === scope && activeScope.current.epoch === epoch;
        const promise = machineGetClaudeModelCatalog(machineId, directory).then(catalog => {
            if (current()) setState({ scope, catalog, error: false });
        }).catch(error => {
            if (current()) setState(previous => ({ scope, catalog: previous.scope === scope ? previous.catalog : null, error: true }));
            throw error;
        }).finally(() => {
            if (pending.current?.promise === promise) pending.current = null;
        });
        pending.current = { scope, epoch, promise };
        return promise;
    }, [scope, epoch, machineId, directory]);
    React.useEffect(() => {
        if (scope) void refresh().catch(() => {});
    }, [scope, refresh]);
    return { catalog: state.scope === scope && scope ? state.catalog : null, error: state.scope === scope && state.error, refresh };
}
