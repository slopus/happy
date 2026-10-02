import * as React from 'react';
import { AppState } from 'react-native';
import { storage } from '@/sync/storage';
import { initializeMessageStagingQueue, messageStagingQueue } from '@/sync/messageStagingQueueRuntime';

export function MessageStagingQueueResumer() {
    React.useEffect(() => {
        void initializeMessageStagingQueue().catch(() => { /* submission reports unavailable storage */ });
        const unsubscribe = storage.subscribe(messageStagingQueue.refresh);
        const subscription = AppState.addEventListener('change', state => {
            if (state === 'active') messageStagingQueue.refresh();
        });
        return () => { unsubscribe(); subscription.remove(); };
    }, []);
    return null;
}
