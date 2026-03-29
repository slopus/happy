/**
 * Stale-while-revalidate hook for git status files.
 *
 * On first visit (no cache): shows isLoading=true while fetching.
 * On subsequent visits (e.g. returning from file view): renders cached data
 * instantly from the Zustand store, refreshes silently in the background.
 * The component only re-renders if the fetched data actually differs from cache.
 */

import * as React from 'react';
import { useFocusEffect } from 'expo-router';
import { getGitStatusFiles, GitStatusFiles } from '@/sync/gitStatusFiles';
import { storage, useSessionGitStatusFiles } from '@/sync/storage';

export function useGitStatusFiles(sessionId: string) {
    const cached = useSessionGitStatusFiles(sessionId);
    const [isFetching, setIsFetching] = React.useState(false);

    const refresh = React.useCallback(async () => {
        setIsFetching(true);
        try {
            const result = await getGitStatusFiles(sessionId);
            storage.getState().applyGitStatusFiles(sessionId, result);
        } catch (error) {
            console.error('Failed to load git status files:', error);
        } finally {
            setIsFetching(false);
        }
    }, [sessionId]);

    // Refresh on mount and every time the screen is focused
    useFocusEffect(
        React.useCallback(() => {
            refresh();
        }, [refresh])
    );

    return {
        data: cached,
        // Only show loading spinner when there's no cached data yet
        isLoading: !cached && isFetching,
    };
}
