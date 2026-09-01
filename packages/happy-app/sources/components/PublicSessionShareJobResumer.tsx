import * as React from 'react';
import { AppState } from 'react-native';
import { resumePublicSessionShareJobs } from '@/sync/publicSessionShareQueueRuntime';

export function PublicSessionShareJobResumer() {
    React.useEffect(() => {
        void resumePublicSessionShareJobs();
        const subscription = AppState.addEventListener('change', (state) => {
            if (state === 'active') void resumePublicSessionShareJobs();
        });
        return () => subscription.remove();
    }, []);
    return null;
}
