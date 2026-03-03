import React, { useCallback, useMemo } from 'react';
import { Platform } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { Modal } from '@/modal';
import { CommandPalette } from './CommandPalette';
import { Command } from './types';
import { useGlobalKeyboard } from '@/hooks/useGlobalKeyboard';
import { useAuth } from '@/auth/AuthContext';
import { storage } from '@/sync/storage';
import { useShallow } from 'zustand/react/shallow';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';

export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
    const router = useRouter();
    const pathname = usePathname();
    const { logout } = useAuth();
    const sessions = storage(useShallow((state) => state.sessions));
    const commandPaletteEnabled = storage(useShallow((state) => state.localSettings.commandPaletteEnabled));
    const navigateToSession = useNavigateToSession();

    // Active sessions sorted by updatedAt (same order as sidebar)
    const activeSessions = useMemo(() => {
        return Object.values(sessions)
            .filter(s => s.active)
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }, [sessions]);

    // All sessions sorted (for Cmd+1..9 — matches sidebar order: active first, then inactive)
    const sidebarOrderSessions = useMemo(() => {
        const active = Object.values(sessions)
            .filter(s => s.active)
            .sort((a, b) => b.updatedAt - a.updatedAt);
        const inactive = Object.values(sessions)
            .filter(s => !s.active)
            .sort((a, b) => b.updatedAt - a.updatedAt);
        return [...active, ...inactive];
    }, [sessions]);

    const currentSessionId = useMemo(() => {
        const match = pathname.match(/\/session\/([^/]+)/);
        return match ? match[1] : null;
    }, [pathname]);

    // Define available commands
    const commands = useMemo((): Command[] => {
        const cmds: Command[] = [
            {
                id: 'new-session',
                title: 'New Session',
                subtitle: 'Start a new chat session',
                icon: 'add-circle-outline',
                category: 'Sessions',
                shortcut: '⌘N',
                action: () => {
                    router.push('/new');
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
                shortcut: '⌘,',
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
            {
                id: 'prev-session',
                title: 'Previous Session',
                subtitle: 'Switch to the previous active session',
                icon: 'arrow-back-outline',
                category: 'Sessions',
                shortcut: '⌘[',
                action: () => navigatePrevSession(),
            },
            {
                id: 'next-session',
                title: 'Next Session',
                subtitle: 'Switch to the next active session',
                icon: 'arrow-forward-outline',
                category: 'Sessions',
                shortcut: '⌘]',
                action: () => navigateNextSession(),
            },
        ];

        // Add session-specific commands with Cmd+N shortcuts
        const recentSessions = Object.values(sessions)
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, 9);

        recentSessions.forEach((session, index) => {
            const sessionName = session.metadata?.name || `Session ${session.id.slice(0, 6)}`;
            cmds.push({
                id: `session-${session.id}`,
                title: sessionName,
                subtitle: session.metadata?.path || 'Switch to session',
                icon: session.active ? 'radio-button-on-outline' : 'time-outline',
                category: session.active ? 'Active Sessions' : 'Recent Sessions',
                shortcut: index < 9 ? `⌘${index + 1}` : undefined,
                action: () => {
                    navigateToSession(session.id);
                }
            });
        });

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
    }, [router, logout, sessions]);

    const showCommandPalette = useCallback(() => {
        if (Platform.OS !== 'web' || !commandPaletteEnabled) return;

        Modal.show({
            component: CommandPalette,
            props: {
                commands,
            }
        } as any);
    }, [commands, commandPaletteEnabled]);

    // Cmd+[ / Cmd+] — cycle only through active sessions
    const navigatePrevSession = useCallback(() => {
        if (activeSessions.length === 0) return;
        if (!currentSessionId) {
            navigateToSession(activeSessions[0].id);
            return;
        }
        const currentIndex = activeSessions.findIndex(s => s.id === currentSessionId);
        if (currentIndex === -1) {
            navigateToSession(activeSessions[0].id);
            return;
        }
        const prevIndex = (currentIndex + 1) % activeSessions.length;
        navigateToSession(activeSessions[prevIndex].id);
    }, [activeSessions, currentSessionId, navigateToSession]);

    const navigateNextSession = useCallback(() => {
        if (activeSessions.length === 0) return;
        if (!currentSessionId) {
            navigateToSession(activeSessions[0].id);
            return;
        }
        const currentIndex = activeSessions.findIndex(s => s.id === currentSessionId);
        if (currentIndex === -1) {
            navigateToSession(activeSessions[0].id);
            return;
        }
        const nextIndex = (currentIndex - 1 + activeSessions.length) % activeSessions.length;
        navigateToSession(activeSessions[nextIndex].id);
    }, [activeSessions, currentSessionId, navigateToSession]);

    // Cmd+1..9 — switch by sidebar order (active first, then inactive)
    const navigateToSessionByIndex = useCallback((index: number) => {
        if (index >= 0 && index < sidebarOrderSessions.length) {
            navigateToSession(sidebarOrderSessions[index].id);
        }
    }, [sidebarOrderSessions, navigateToSession]);

    // Set up global keyboard shortcuts
    useGlobalKeyboard({
        onCommandPalette: commandPaletteEnabled ? showCommandPalette : undefined,
        onNewSession: useCallback(() => router.push('/new'), [router]),
        onSettings: useCallback(() => router.push('/settings'), [router]),
        onPrevSession: navigatePrevSession,
        onNextSession: navigateNextSession,
        onSessionByIndex: navigateToSessionByIndex,
    });

    return <>{children}</>;
}
