import { create } from 'zustand';

type Entry = { owner: object; back: () => void; close: () => void };
/** Only the focused role surface owns this small local navigation override. */
export const useRoleFlowNavigationStore = create<{ entry: Entry | null }>(() => ({ entry: null }));
export function registerRoleFlowNavigation(entry: Entry) {
    useRoleFlowNavigationStore.setState({ entry });
    return () => { if (useRoleFlowNavigationStore.getState().entry?.owner === entry.owner) useRoleFlowNavigationStore.setState({ entry: null }); };
}
export function runRoleFlowNavigationBack() {
    const entry = useRoleFlowNavigationStore.getState().entry;
    if (!entry) return false;
    entry.back(); return true;
}
export function runRoleFlowNavigationClose() {
    const entry = useRoleFlowNavigationStore.getState().entry;
    if (!entry) return false;
    entry.close(); return true;
}
