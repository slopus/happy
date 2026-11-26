import * as React from 'react';
import type { DelegationRole } from '@slopus/happy-wire';
import { listMachineDelegationRoles } from '@/sync/apiDelegation';
import { apiSocket } from '@/sync/apiSocket';
import { getFirstSubmissionScope, subscribeFirstSubmissionScope } from '@/sync/firstSubmissionScope';
import { t } from '@/text';

/** Read on entry and reconnect, including after AI edits in another screen; never poll. */
export function useMachineDelegationRoles(machineId: string, enabled: boolean, focused = true) {
    const account = React.useSyncExternalStore(subscribeFirstSubmissionScope, getFirstSubmissionScope, getFirstSubmissionScope);
    const [connected, setConnected] = React.useState(false);
    React.useEffect(() => {
        const unsubscribe = apiSocket.onStatusChange(status => setConnected(status === 'connected'));
        return () => { unsubscribe(); };
    }, []);
    const scope = React.useMemo(() => ({ account, machineId, enabled, connected }), [account, machineId, enabled, connected]);
    const current = React.useRef<typeof scope | null>(scope);
    current.current = scope;
    const sequence = React.useRef(0);
    const [state, setState] = React.useState<{ scope: typeof scope; roles: DelegationRole[]; loading: boolean; error: string | null }>();
    const isCurrent = React.useCallback(() => current.current === scope && getFirstSubmissionScope() === account, [scope, account]);
    const refresh = React.useCallback(async () => {
        if (!enabled || !account || !connected) return;
        const request = ++sequence.current;
        setState(previous => ({ scope, roles: previous?.scope === scope ? previous.roles : [], loading: true, error: null }));
        try {
            const roles = await listMachineDelegationRoles(machineId);
            if (isCurrent() && sequence.current === request) setState({ scope, roles, loading: false, error: null });
        } catch (failure) {
            if (isCurrent() && sequence.current === request) setState(previous => ({ scope,
                roles: previous?.scope === scope ? previous.roles : [], loading: false,
                error: failure instanceof Error ? failure.message : t('delegation.roleLoadFailed'),
            }));
        }
    }, [scope, enabled, connected, machineId, isCurrent]);
    React.useEffect(() => {
        current.current = scope;
        if (focused) void refresh();
        else sequence.current++;
        return () => { if (current.current === scope) current.current = null; };
    }, [scope, refresh, focused]);
    const apply = (roles: DelegationRole[]) => {
        if (!isCurrent()) return;
        sequence.current++;
        setState({ scope, roles, loading: false, error: null });
    };
    return { scope, connected, isCurrent, refresh, apply, roles: state?.scope === scope ? state.roles : [],
        loading: enabled && !!account && (!connected || state?.scope !== scope || state.loading), error: state?.scope === scope ? state.error : null };
}
