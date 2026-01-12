import React from 'react';
import { useAuth } from '@/auth/AuthContext';
import { kvGet, kvSet, KvItem } from '@/sync/apiKv';

/**
 * Tab types for the main navigation
 * Note: 'zen' is included for TabBar compatibility but not actively used
 */
export type TabType = 'zen' | 'inbox' | 'sessions' | 'settings';

const TAB_STATE_KEY = 'ui:active-tab';
const DEFAULT_TAB: TabType = 'sessions';

interface TabState {
    activeTab: TabType;
    version: number;
}

/**
 * Hook for persistent tab state that syncs to the server.
 *
 * Features:
 * - Loads tab state from server on mount
 * - Saves tab changes to server with optimistic updates
 * - Handles version conflicts gracefully
 * - Falls back to 'sessions' if no saved state
 *
 * Usage:
 *   const { activeTab, setActiveTab, isLoading } = useTabState();
 */
export function useTabState() {
    const { credentials } = useAuth();
    const [state, setState] = React.useState<TabState>({
        activeTab: DEFAULT_TAB,
        version: -1
    });
    const [isLoading, setIsLoading] = React.useState(true);

    // Load initial state from server
    React.useEffect(() => {
        if (!credentials) {
            setIsLoading(false);
            return;
        }

        let mounted = true;

        async function loadTabState() {
            try {
                const item = await kvGet(credentials!, TAB_STATE_KEY);

                if (!mounted) return;

                if (item) {
                    const tab = item.value as TabType;
                    // Validate the tab value (zen is excluded as it's not active)
                    if (tab === 'sessions' || tab === 'inbox' || tab === 'settings') {
                        setState({
                            activeTab: tab,
                            version: item.version
                        });
                    }
                }
            } catch (error) {
                console.warn('[TabState] Failed to load tab state:', error);
            } finally {
                if (mounted) {
                    setIsLoading(false);
                }
            }
        }

        loadTabState();

        return () => {
            mounted = false;
        };
    }, [credentials]);

    // Set active tab with server sync
    const setActiveTab = React.useCallback(async (tab: TabType) => {
        // Optimistic update
        setState(prev => ({
            activeTab: tab,
            version: prev.version
        }));

        if (!credentials) return;

        try {
            const newVersion = await kvSet(
                credentials,
                TAB_STATE_KEY,
                tab,
                state.version
            );

            setState(prev => ({
                ...prev,
                version: newVersion
            }));
        } catch (error) {
            console.warn('[TabState] Failed to save tab state:', error);
            // On conflict, reload the current state from server
            if (String(error).includes('version-mismatch')) {
                try {
                    const item = await kvGet(credentials, TAB_STATE_KEY);
                    if (item) {
                        const serverTab = item.value as TabType;
                        if (serverTab === 'sessions' || serverTab === 'inbox' || serverTab === 'settings' || serverTab === 'zen') {
                            setState({
                                activeTab: serverTab,
                                version: item.version
                            });
                        }
                    }
                } catch {
                    // Ignore reload errors
                }
            }
        }
    }, [credentials, state.version]);

    return {
        activeTab: state.activeTab,
        setActiveTab,
        isLoading
    };
}
