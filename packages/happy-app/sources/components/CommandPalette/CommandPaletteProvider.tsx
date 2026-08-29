import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { Modal, useModal } from '@/modal';
import { CommandPalette } from './CommandPalette';
import { Command } from './types';
import { useGlobalKeyboard } from '@/hooks/useGlobalKeyboard';
import { useAuth } from '@/auth/AuthContext';
import { storage } from '@/sync/storage';
import { useShallow } from 'zustand/react/shallow';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { useDesktopSettingsModal } from '@/components/DesktopSettingsModal';
import { t } from '@/text';
import { formatLastSeen } from '@/utils/sessionUtils';
import type { Message } from '@/sync/typesMessage';

interface CommandPaletteLauncher {
    isAvailable: boolean;
    open: () => void;
}

const CommandPaletteLauncherContext = createContext<CommandPaletteLauncher | null>(null);

export function useCommandPaletteLauncher(): CommandPaletteLauncher | null {
    return useContext(CommandPaletteLauncherContext);
}

function normalizePath(path: string): string {
    return path.replace(/[\\/]+$/, '');
}

function normalizeComparablePath(path: string, homeDir?: string): string {
    if (homeDir && (path === '~' || path.startsWith('~/') || path.startsWith('~\\'))) {
        return normalizePath(`${normalizePath(homeDir)}${path.slice(1)}`);
    }
    return normalizePath(path);
}

function projectNameFromPath(path: string): string {
    const normalized = normalizePath(path);
    return normalized.split(/[\\/]/).filter(Boolean).at(-1) ?? normalized;
}

function displayAgentFlavor(flavor: string | null | undefined): string | null {
    if (!flavor) return null;
    return flavor.charAt(0).toLocaleUpperCase() + flavor.slice(1);
}

export function firstUserMessageSummary(messages: Message[] | undefined): string | null {
    let firstUserMessage: Extract<Message, { kind: 'user-text' }> | null = null;
    for (const message of messages ?? []) {
        if (message.kind !== 'user-text') continue;
        if (!firstUserMessage || message.createdAt < firstUserMessage.createdAt) {
            firstUserMessage = message;
        }
    }
    if (!firstUserMessage) return null;

    const text = (firstUserMessage.displayText ?? firstUserMessage.text).replace(/\s+/g, ' ').trim();
    if (!text) return null;
    return text.length <= 180 ? text : `${text.slice(0, 177).trimEnd()}...`;
}

export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
    const router = useRouter();
    const { openSettings } = useDesktopSettingsModal();
    const { logout } = useAuth();
    const { state: modalState, showModal } = useModal();
    const paletteOpeningRef = useRef(false);
    const sessions = storage(useShallow((state) => state.sessions));
    const firstUserMessageSummaries = storage(useShallow((state) => {
        const summaries: Record<string, string> = {};
        for (const [sessionId, data] of Object.entries(state.sessionMessages)) {
            const summary = firstUserMessageSummary(data.messages);
            if (summary) summaries[sessionId] = summary;
        }
        return summaries;
    }));
    const machines = storage(useShallow((state) => state.machines));
    const agents = storage(useShallow((state) => state.localSettings.agents));
    const currentViewingSessionId = storage(useShallow((state) => state.currentViewingSessionId));
    const navigateToSession = useNavigateToSession();
    const paletteIsOpen = modalState.modals.some((modal) => (
        modal.type === 'custom' && modal.component === CommandPalette
    ));

    useEffect(() => {
        paletteOpeningRef.current = paletteIsOpen;
    }, [paletteIsOpen]);

    const confirmLogout = useCallback(async () => {
        const confirmed = await Modal.confirm(
            t('common.logout'),
            t('settingsAccount.logoutConfirm'),
            { confirmText: t('common.logout'), destructive: true },
        );
        if (confirmed) {
            await logout();
        }
    }, [logout]);

    // Define available commands
    const commands = useMemo((): Command[] => {
        const cmds: Command[] = [
            // Navigation commands
            {
                id: 'new-session',
                title: t('newSession.title'),
                subtitle: t('commandPalette.newSessionSubtitle'),
                icon: 'add-circle-outline',
                category: t('sessionHistory.title'),
                shortcut: '⌘N',
                action: () => {
                    router.navigate('/new');
                }
            },
            {
                id: 'sessions',
                title: t('sessionHistory.viewAll'),
                subtitle: t('commandPalette.allSessionsSubtitle'),
                icon: 'chatbubbles-outline',
                category: t('sessionHistory.title'),
                action: () => {
                    router.push('/');
                }
            },
            {
                id: 'settings',
                title: t('settings.title'),
                subtitle: t('commandPalette.settingsSubtitle'),
                icon: 'settings-outline',
                category: t('commandPalette.navigation'),
                shortcut: '⌘,',
                action: openSettings,
            },
            {
                id: 'account',
                title: t('settings.account'),
                subtitle: t('settings.accountSubtitle'),
                icon: 'person-circle-outline',
                category: t('commandPalette.navigation'),
                action: () => {
                    router.push('/settings/account');
                }
            },
            {
                id: 'connect',
                title: t('settingsAccount.linkNewDevice'),
                subtitle: t('settingsAccount.linkNewDeviceSubtitle'),
                icon: 'link-outline',
                category: t('commandPalette.navigation'),
                action: () => {
                    router.push('/terminal/connect');
                }
            },
        ];

        const recentSessions = Object.values(sessions).sort((a, b) => b.updatedAt - a.updatedAt);
        const currentSession = currentViewingSessionId ? sessions[currentViewingSessionId] : undefined;
        const projectSession = currentSession?.metadata?.path
            ? currentSession
            : recentSessions.find((session) => Boolean(session.metadata?.path));

        // Reuse the existing session file browser. The focused variant lands directly in its search input.
        if (projectSession) {
            const filesRoute = `/session/${projectSession.id}/files`;
            const projectPath = projectSession.metadata?.path ?? t('common.files');
            cmds.push(
                {
                    id: 'open-project-folder',
                    title: t('rightPanelCapabilityHub.blocks.folderBrowser'),
                    subtitle: projectPath,
                    icon: 'folder-open-outline',
                    category: t('commandPalette.navigation'),
                    action: () => router.push(filesRoute as any),
                },
                {
                    id: 'search-project-files',
                    title: t('tools.names.searchFiles'),
                    subtitle: projectPath,
                    icon: 'search-outline',
                    category: t('commandPalette.navigation'),
                    action: () => router.push(`${filesRoute}?focus=search` as any),
                },
            );
        }

        // Add session-specific commands. metadata.summary is the generated session title;
        // the first loaded user message remains a separate searchable/displayed summary.
        recentSessions.forEach((session, index) => {
            const path = session.metadata?.path ?? '';
            const normalizedSessionPath = normalizeComparablePath(path, session.metadata?.homeDir);
            const projectName = path ? projectNameFromPath(path) : null;
            const machineId = session.metadata?.machineId;
            const machine = machineId ? machines[machineId] : undefined;
            const machineName = machine?.metadata?.displayName
                || machine?.metadata?.host
                || session.metadata?.host
                || machineId
                || null;
            const matchingAgentNames = agents
                .filter((agent) => (
                    agent.machineId === machineId
                    && normalizeComparablePath(agent.path, session.metadata?.homeDir) === normalizedSessionPath
                ))
                .map((agent) => agent.name);
            const flavorName = displayAgentFlavor(session.metadata?.flavor);
            const agentName = Array.from(new Set([
                ...matchingAgentNames,
                flavorName,
            ].filter((value): value is string => Boolean(value)))).join(' · ');
            const sessionName = session.metadata?.summary?.text
                || session.metadata?.name
                || `${t('machine.untitledSession')} ${session.id.slice(0, 6)}`;
            const firstMessageSummary = firstUserMessageSummaries[session.id] ?? null;
            cmds.push({
                id: `session-${session.id}`,
                title: sessionName,
                subtitle: path || t('commandPalette.switchToSession'),
                metadata: [
                    ...(firstMessageSummary ? [{ icon: 'chatbubble-outline', text: firstMessageSummary }] : []),
                    ...(projectName ? [{ icon: 'folder-outline', text: projectName }] : []),
                    ...(machineName ? [{ icon: 'desktop-outline', text: machineName }] : []),
                    ...(agentName ? [{ icon: 'sparkles-outline', text: agentName }] : []),
                    { icon: 'time-outline', text: formatLastSeen(session.updatedAt) },
                ],
                keywords: [
                    path,
                    firstMessageSummary,
                    projectName,
                    machineName,
                    ...matchingAgentNames,
                    session.metadata?.flavor,
                ].filter((value): value is string => Boolean(value)),
                icon: 'time-outline',
                category: t('commandPalette.recentSessions'),
                showWhenEmpty: index < 5,
                action: () => {
                    navigateToSession(session.id);
                }
            });
        });

        // System commands
        cmds.push({
            id: 'sign-out',
            title: t('settingsAccount.logout'),
            subtitle: t('settingsAccount.logoutSubtitle'),
            icon: 'log-out-outline',
            category: t('commandPalette.system'),
            action: confirmLogout,
        });

        // Dev commands (if in development)
        if (__DEV__) {
            cmds.push({
                id: 'dev-menu',
                title: t('settings.developerTools'),
                subtitle: t('commandPalette.developerSubtitle'),
                icon: 'code-slash-outline',
                category: t('settings.developer'),
                action: () => {
                    router.push('/dev');
                }
            });
        }

        return cmds;
    }, [router, sessions, firstUserMessageSummaries, machines, agents, currentViewingSessionId, navigateToSession, confirmLogout, openSettings]);

    const showCommandPalette = useCallback(() => {
        if (Platform.OS !== 'web' || paletteOpeningRef.current) return;

        // Guard synchronously as well as from modal state so a held/repeated
        // shortcut cannot enqueue two palettes before React re-renders.
        paletteOpeningRef.current = true;
        showModal({
            type: 'custom',
            component: CommandPalette,
            props: {
                commands,
            }
        } as any);
    }, [commands, showModal]);

    useGlobalKeyboard(showCommandPalette, { onOpenSettings: openSettings });

    const launcher = useMemo((): CommandPaletteLauncher => ({
        isAvailable: Platform.OS === 'web',
        open: showCommandPalette,
    }), [showCommandPalette]);

    return (
        <CommandPaletteLauncherContext.Provider value={launcher}>
            {children}
        </CommandPaletteLauncherContext.Provider>
    );
}
