import React, { useCallback, useMemo } from 'react';
import { Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { Modal } from '@/modal';
import { CommandPalette } from './CommandPalette';
import { Command } from './types';
import { useGlobalKeyboard } from '@/hooks/useGlobalKeyboard';
import { useAuth } from '@/auth/AuthContext';
import { storage, useAllMachines } from '@/sync/storage';
import { useShallow } from 'zustand/react/shallow';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { ShortcutHintsProvider } from '@/components/ShortcutHints';
import {
    formatShortcut,
    getPreferredShortcutModifier,
} from '@/keyboard/shortcuts';
import { isTauri } from '@/utils/isTauri';
import { useVisibleSessionListViewData } from '@/hooks/useVisibleSessionListViewData';
import { getSessionShortcutIdsInDisplayOrder } from '@/utils/sessionDisplayOrder';
import { t } from '@/text';

const EMPTY_SESSION_IDS: readonly string[] = [];

export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
    const router = useRouter();
    const { logout, isAuthenticated } = useAuth();
    const commandPaletteEnabled = storage(useShallow((state) => state.localSettings.commandPaletteEnabled));
    const sessionListViewData = useVisibleSessionListViewData();
    const machines = useAllMachines();
    const navigateToSession = useNavigateToSession();
    const preferredModifier = useMemo(() => getPreferredShortcutModifier(
        typeof navigator === 'undefined' ? undefined : navigator
    ), []);
    const browserSafeShortcuts = useMemo(() => Platform.OS === 'web' && !isTauri(), []);
    const visibleSessionShortcutIds = useMemo(() => getSessionShortcutIdsInDisplayOrder(
        sessionListViewData,
        machines,
        t('status.unknown'),
    ), [machines, sessionListViewData]);

    // Define available commands. The recent-session entries are built when the
    // palette opens (see showCommandPalette): subscribing to the sessions map
    // here re-rendered this provider and re-sorted every session on each socket
    // event for any session, while the palette opens rarely.
    const navigationCommands = useMemo((): Command[] => {
        const cmds: Command[] = [
            // Navigation commands
            {
                id: 'new-session',
                title: 'New Session',
                subtitle: 'Start a new chat session',
                icon: 'add-circle-outline',
                category: 'Sessions',
                shortcut: formatShortcut(preferredModifier, 'N', browserSafeShortcuts),
                action: () => {
                    router.navigate('/new');
                }
            },
            {
                id: 'sessions',
                title: 'View All Sessions',
                subtitle: 'Browse your chat history',
                icon: 'chatbubbles-outline',
                category: 'Sessions',
                action: () => {
                    router.push('/');
                }
            },
            {
                id: 'settings',
                title: 'Settings',
                subtitle: 'Configure your preferences',
                icon: 'settings-outline',
                category: 'Navigation',
                shortcut: formatShortcut(preferredModifier, ',', browserSafeShortcuts),
                action: () => {
                    router.push('/settings');
                }
            },
            {
                id: 'account',
                title: 'Account',
                subtitle: 'Manage your account',
                icon: 'person-circle-outline',
                category: 'Navigation',
                action: () => {
                    router.push('/settings/account');
                }
            },
            {
                id: 'connect',
                title: 'Connect Device',
                subtitle: 'Connect a new device via web',
                icon: 'link-outline',
                category: 'Navigation',
                action: () => {
                    router.push('/terminal/connect');
                }
            },
        ];
        return cmds;
    }, [browserSafeShortcuts, router, preferredModifier]);

    const systemCommands = useMemo((): Command[] => {
        const cmds: Command[] = [];

        // System commands
        cmds.push({
            id: 'sign-out',
            title: 'Sign Out',
            subtitle: 'Sign out of your account',
            icon: 'log-out-outline',
            category: 'System',
            action: async () => {
                await logout();
            }
        });

        // Dev commands (if in development)
        if (__DEV__) {
            cmds.push({
                id: 'dev-menu',
                title: 'Developer Menu',
                subtitle: 'Access developer tools',
                icon: 'code-slash-outline',
                category: 'Developer',
                action: () => {
                    router.push('/dev');
                }
            });
        }

        return cmds;
    }, [logout, router]);

    const showCommandPalette = useCallback(() => {
        if (Platform.OS !== 'web' || !isAuthenticated || !commandPaletteEnabled) return;

        // Read the sessions once, now, instead of subscribing to them.
        const recentSessions = Object.values(storage.getState().sessions)
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, 5);
        const sessionCommands = recentSessions.map((session): Command => ({
            id: `session-${session.id}`,
            title: session.metadata?.name || `Session ${session.id.slice(0, 6)}`,
            subtitle: session.metadata?.path || 'Switch to session',
            icon: 'time-outline',
            category: 'Recent Sessions',
            action: () => {
                navigateToSession(session.id);
            }
        }));

        Modal.show({
            component: CommandPalette,
            props: {
                commands: [...navigationCommands, ...sessionCommands, ...systemCommands],
            }
        } as any);
    }, [commandPaletteEnabled, isAuthenticated, navigateToSession, navigationCommands, systemCommands]);

    const openNewSession = useCallback(() => {
        router.navigate('/new');
    }, [router]);

    const openSettings = useCallback(() => {
        router.push('/settings');
    }, [router]);

    const openRecentSession = useCallback((index: number) => {
        const sessionId = visibleSessionShortcutIds[index];
        if (!sessionId) {
            return false;
        }
        navigateToSession(sessionId);
        return true;
    }, [navigateToSession, visibleSessionShortcutIds]);

    const visibleModifier = useGlobalKeyboard(
        {
            commandPalette: isAuthenticated && commandPaletteEnabled ? showCommandPalette : undefined,
            newSession: isAuthenticated ? openNewSession : undefined,
            settings: isAuthenticated ? openSettings : undefined,
            recentSession: isAuthenticated ? openRecentSession : undefined,
        },
        browserSafeShortcuts,
    );

    return (
        <ShortcutHintsProvider
            modifier={isAuthenticated ? visibleModifier : null}
            commandPaletteEnabled={isAuthenticated && commandPaletteEnabled}
            recentSessionIds={isAuthenticated ? visibleSessionShortcutIds : EMPTY_SESSION_IDS}
            browserSafeShortcuts={browserSafeShortcuts}
        >
            {children}
        </ShortcutHintsProvider>
    );
}
