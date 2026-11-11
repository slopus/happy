import { useCallback, useSyncExternalStore } from 'react';

type FileAnnotationUi = Readonly<{
    marking: boolean;
    panelOpen: boolean;
    activeId?: string;
    unlocatedId?: string;
    focus?: { id: string; sequence: number; edit?: boolean; path?: string };
}>;
const empty: FileAnnotationUi = Object.freeze({ marking: false, panelOpen: false });
const sessions = new Map<string, FileAnnotationUi>();
const listeners = new Set<() => void>();
let sequence = 0;
export const fileAnnotationUi = {
    getSnapshot: (sessionId: string) => sessions.get(sessionId) ?? empty,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    update(sessionId: string, patch: Partial<FileAnnotationUi>) {
        const old = sessions.get(sessionId) ?? empty;
        if (Object.entries(patch).every(([key, value]) => old[key as keyof FileAnnotationUi] === value)) return;
        sessions.set(sessionId, { ...old, ...patch });
        listeners.forEach(listener => listener());
    },
    focus(sessionId: string, id: string, edit = false, path?: string) {
        fileAnnotationUi.update(sessionId, { activeId: id, unlocatedId: undefined, focus: { id, sequence: ++sequence, edit, path } });
    },
};
export function useFileAnnotationUi(sessionId: string) {
    return useSyncExternalStore(fileAnnotationUi.subscribe, useCallback(() => fileAnnotationUi.getSnapshot(sessionId), [sessionId]), () => empty);
}
