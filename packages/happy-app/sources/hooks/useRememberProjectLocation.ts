import * as React from 'react';
import { useFocusEffect } from 'expo-router';
import { accountRuntimeCurrent } from '@/auth/accountRuntime';
import { useLocalSettingMutable } from '@/sync/storage';
import { projectLocationHref } from '@/utils/projectReturnLocation';

/** Capture the focused project screen, never another route's global parameters. */
export function useRememberProjectLocation(location: Record<string, unknown>, enabled: boolean) {
    const [saved, setSaved] = useLocalSettingMutable('desktopProjectLocation');
    const href = enabled ? projectLocationHref(location) : null;
    useFocusEffect(React.useCallback(() => {
        if (enabled && accountRuntimeCurrent() && saved !== href) setSaved(href);
    }, [enabled, href, saved, setSaved]));
}
