import * as React from 'react';
import { useRouter } from 'expo-router';
import { useInboxFriendsEnabled } from '@/hooks/useInboxFriendsEnabled';

export function useRequireInboxFriendsEnabled(): boolean {
    const router = useRouter();
    const enabled = useInboxFriendsEnabled();

    React.useEffect(() => {
        if (enabled) return;
        router.replace('/');
    }, [enabled, router]);

    return enabled;
}

