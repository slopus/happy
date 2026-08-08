import * as React from 'react';
import type {
    ConversationActivityStatus,
    SubagentConversationActivity,
} from '@/utils/conversationActivity';

export type SubagentInspectorSelection = Pick<SubagentConversationActivity, 'id' | 'title'> & {
    status: ConversationActivityStatus;
};

export type SubagentInspectorContextValue = {
    selection: SubagentInspectorSelection | null;
    open: (selection: SubagentInspectorSelection) => void;
    close: () => void;
};

const SubagentInspectorContext = React.createContext<SubagentInspectorContextValue | null>(null);

export const SubagentInspectorProvider = React.memo(function SubagentInspectorProvider({
    children,
    sessionId,
}: React.PropsWithChildren<{ sessionId: string }>) {
    const [selection, setSelection] = React.useState<SubagentInspectorSelection | null>(null);
    const open = React.useCallback((nextSelection: SubagentInspectorSelection) => {
        setSelection(nextSelection);
    }, []);
    const close = React.useCallback(() => {
        setSelection(null);
    }, []);

    React.useEffect(() => {
        setSelection(null);
    }, [sessionId]);

    const value = React.useMemo<SubagentInspectorContextValue>(() => ({
        selection,
        open,
        close,
    }), [close, open, selection]);

    return (
        <SubagentInspectorContext.Provider value={value}>
            {children}
        </SubagentInspectorContext.Provider>
    );
});

export function useSubagentInspector(): SubagentInspectorContextValue | null {
    return React.useContext(SubagentInspectorContext);
}
