import * as React from 'react';

/** Resolve before navigation so the catalog never passes through a details-only layout. */
export function useTaskCardSelection({ selectedId, context, resolve, commit, onError }: {
    selectedId?: string;
    context: string;
    resolve: (id: string) => Promise<string | undefined>;
    commit: (id: string, conversation?: string) => void;
    onError: (error: unknown) => void;
}) {
    const latest = React.useRef({ selectedId, context, resolve, commit, onError });
    latest.current = { selectedId, context, resolve, commit, onError };
    const request = React.useRef<{ id: string; context: string } | undefined>(undefined);
    const alive = React.useRef(true);
    React.useEffect(() => { alive.current = true; return () => { alive.current = false; request.current = undefined; }; }, []);
    return React.useCallback(async (id: string) => {
        const owner = latest.current;
        // Selecting a card is idempotent; closing chat stays an explicit action.
        if (id === owner.selectedId || (request.current?.id === id && request.current.context === owner.context)) {
            if (id === owner.selectedId) request.current = undefined;
            return;
        }
        const token = { id, context: owner.context };
        request.current = token;
        const current = () => alive.current && request.current === token && latest.current.context === owner.context;
        try {
            const conversation = await owner.resolve(id);
            if (current()) latest.current.commit(id, conversation);
        } catch (error) {
            if (current()) latest.current.onError(error);
        } finally {
            if (request.current === token) request.current = undefined;
        }
    }, []);
}
