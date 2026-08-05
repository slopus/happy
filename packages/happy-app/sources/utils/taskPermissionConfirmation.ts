import type { TaskPermissionLevel } from './taskPermissionModes';

export type TaskPermissionConfirmationStore = {
    hasConfirmed: (sessionId: string) => boolean;
    markConfirmed: (sessionId: string) => void;
};

export function createTaskPermissionConfirmationStore(): TaskPermissionConfirmationStore {
    const confirmedSessionIds = new Set<string>();
    return {
        hasConfirmed: (sessionId) => confirmedSessionIds.has(sessionId),
        markConfirmed: (sessionId) => confirmedSessionIds.add(sessionId),
    };
}
export const taskPermissionConfirmationStore = createTaskPermissionConfirmationStore();

/**
 * Applies a permission change behind a session-scoped full-access gate. The
 * confirmation is recorded only after the requested mode was actually applied.
 */
export async function applyTaskPermissionSelection(options: {
    sessionId: string;
    level: TaskPermissionLevel;
    store: TaskPermissionConfirmationStore;
    confirmFullAccess: () => Promise<boolean>;
    apply: () => void | Promise<void>;
}): Promise<boolean> {
    if (
        options.level === 'full-access'
        && !options.store.hasConfirmed(options.sessionId)
        && !await options.confirmFullAccess()
    ) {
        return false;
    }

    await options.apply();
    if (options.level === 'full-access') {
        options.store.markConfirmed(options.sessionId);
    }
    return true;
}
