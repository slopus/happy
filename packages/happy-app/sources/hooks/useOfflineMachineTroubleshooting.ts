import * as React from 'react';
import { useRouter } from 'expo-router';

/**
 * Opens the troubleshooting screen for an account whose linked computers are
 * all offline. It used to be an alert; the screen has room to say what to
 * check and to hand over the AI prompt without a dialog in the way.
 */
export function useOfflineMachineTroubleshooting(): () => void {
    const router = useRouter();
    return React.useCallback(() => {
        router.push('/troubleshoot');
    }, [router]);
}
