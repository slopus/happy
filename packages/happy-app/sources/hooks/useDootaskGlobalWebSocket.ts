/**
 * Global DooTask WebSocket connector hook.
 *
 * Call once at the app root level. Watches the DooTask profile in storage:
 * - When a profile exists, connects the global dootaskWS singleton.
 * - When the profile is removed (logout/disconnect), disconnects.
 * - Registers a 'projectTask' message handler that updates the task list in storage.
 */

import { useEffect } from 'react';
import { dootaskWS } from '@/sync/dootask/dootaskWebSocket';
import { useDootaskProfile } from '@/sync/storage';
import { storage } from '@/sync/storage';

export function useDootaskGlobalWebSocket() {
    const profile = useDootaskProfile();

    // Connect / disconnect based on profile
    useEffect(() => {
        if (profile) {
            dootaskWS.connect(profile.serverUrl, profile.token);
        } else {
            dootaskWS.disconnect();
        }
        return () => {
            dootaskWS.disconnect();
        };
    }, [profile?.serverUrl, profile?.token]);

    // Register projectTask handler
    useEffect(() => {
        if (!profile) return;

        const unsub = dootaskWS.onMessage('projectTask', (msg) => {
            const action: string | undefined = msg.action;
            const data = msg.data;
            if (!data) return;

            switch (action) {
                case 'update':
                case 'archived':
                case 'recovery':
                    // In-place update if the task is in our list
                    storage.getState().updateDootaskTask(data.id, data);
                    break;
                case 'add':
                case 'restore':
                case 'delete':
                    // Refresh the full list for structural changes
                    storage.getState().fetchDootaskTasks({ refresh: true });
                    break;
                // NOTE: DooTask also sends 'dialog', 'upload', 'filedelete', 'relation' actions.
                // These are not handled because Happy currently only displays task lists, not full task detail views.
            }
        });

        return unsub;
    }, [!!profile]);

    // Increment msg_num on task list/detail when a new chat message arrives
    useEffect(() => {
        if (!profile) return;

        const unsub = dootaskWS.onMessage('dialog', (msg) => {
            const mode = msg.mode ?? msg.data?.mode;
            if (mode !== 'add' && mode !== 'chat') return;

            const dialogId: number | undefined = msg.data?.dialog_id ?? msg.data?.data?.dialog_id;
            if (!dialogId) return;

            // Find the task matching this dialog_id and increment its msg_num
            const state = storage.getState();
            const task = state.dootaskTasks.find((t) => t.dialog_id === dialogId);
            if (task) {
                state.updateDootaskTask(task.id, { msg_num: (task.msg_num || 0) + 1 });
            }
        });

        return unsub;
    }, [!!profile]);
}
