import * as React from 'react';
import type { DelegationRole, DelegationRoleInput } from '@slopus/happy-wire';
import type { getFirstSubmissionScope } from '@/sync/firstSubmissionScope';
import type {
    ConversationActivityStatus,
    SubagentConversationActivity,
} from '@/utils/conversationActivity';

export type SubagentInspectorSelection = Pick<SubagentConversationActivity, 'id' | 'title'> & {
    status: ConversationActivityStatus;
    kind?: 'native' | 'delegated-task' | 'agent-roles' | 'role-detail';
    roleId?: string;
    parentSessionId?: string;
    machineId?: string;
    savedRole?: DelegationRole;
    roleOwner?: ReturnType<typeof getFirstSubmissionScope>;
};

export type SubagentInspectorContextValue = {
    selection: SubagentInspectorSelection | null;
    open: (selection: SubagentInspectorSelection) => void;
    close: (options?: { restoreFocus?: boolean }) => void;
    delegationRoles?: DelegationRole[] | null;
    setDelegationRoles?: (roles: DelegationRole[] | null) => void;
    roleDrafts?: React.MutableRefObject<Map<string, DelegationRoleInput>>;
    taskViews?: React.MutableRefObject<Map<string, { tab: 'task' | 'context' | 'result'; version?: number }>>;
};

const SubagentInspectorContext = React.createContext<SubagentInspectorContextValue | null>(null);

export const SubagentInspectorProvider = React.memo(function SubagentInspectorProvider({
    children,
    sessionId,
}: React.PropsWithChildren<{ sessionId: string }>) {
    const [selection, setSelection] = React.useState<SubagentInspectorSelection | null>(null);
    const [delegationRoles, setDelegationRoles] = React.useState<DelegationRole[] | null>(null);
    const roleDrafts = React.useRef(new Map<string, DelegationRoleInput>());
    const taskViews = React.useRef(new Map<string, { tab: 'task' | 'context' | 'result'; version?: number }>());
    const trigger = React.useRef<HTMLElement | null>(null);
    const open = React.useCallback((nextSelection: SubagentInspectorSelection) => {
        trigger.current = typeof document !== 'undefined' && nextSelection.kind && nextSelection.kind !== 'native'
            ? document.activeElement as HTMLElement | null : null;
        setSelection(nextSelection);
    }, []);
    const close = React.useCallback((options?: { restoreFocus?: boolean }) => {
        const previous = trigger.current;
        trigger.current = null;
        setSelection(null);
        if (options?.restoreFocus !== false && previous?.isConnected) queueMicrotask(() => {
            if (previous.isConnected) previous.focus({ preventScroll: true });
        });
    }, []);

    React.useEffect(() => {
        setSelection(null);
        setDelegationRoles(null);
        roleDrafts.current.clear();
        taskViews.current.clear();
        trigger.current = null;
    }, [sessionId]);

    const value = React.useMemo<SubagentInspectorContextValue>(() => ({
        selection,
        open,
        close,
        delegationRoles,
        setDelegationRoles,
        roleDrafts,
        taskViews,
    }), [close, open, selection, delegationRoles]);

    return (
        <SubagentInspectorContext.Provider value={value}>
            {children}
        </SubagentInspectorContext.Provider>
    );
});

export function useSubagentInspector(): SubagentInspectorContextValue | null {
    return React.useContext(SubagentInspectorContext);
}
