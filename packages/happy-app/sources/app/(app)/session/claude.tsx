import React from 'react';
import { View, ActivityIndicator, NativeScrollEvent, NativeSyntheticEvent, Pressable } from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Text } from '@/components/StyledText';
import { useAllMachines } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { machineListClaudeSessions, machineSpawnNewSession, machineGetClaudeSessionPreview, machineForkClaudeSession, ClaudeSessionIndexEntry, ClaudeSessionPreviewMessage } from '@/sync/ops';
import { SessionPreviewSheet } from '@/components/SessionPreviewSheet';
import { Modal } from '@/modal';
import { useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { t } from '@/text';
import { sync } from '@/sync/sync';
import { formatPathRelativeToHome } from '@/utils/sessionUtils';
import { MMKV } from 'react-native-mmkv';

const mmkv = new MMKV();
const SELECTED_MACHINE_KEY = 'claude-history-selected-machine';

const rightIconStyle = {
    width: 29,
    height: 29,
    alignItems: 'center',
    justifyContent: 'center',
} as const;

type ClaudeHistoryGroup = {
    key: string;
    label: string;
    entries: ClaudeSessionIndexEntry[];
};

function formatDateHeader(date: Date): string {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    const sessionDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

    if (sessionDate.getTime() === today.getTime()) {
        return t('sessionHistory.today');
    } else if (sessionDate.getTime() === yesterday.getTime()) {
        return t('sessionHistory.yesterday');
    } else {
        const diffTime = today.getTime() - sessionDate.getTime();
        const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
        return t('sessionHistory.daysAgo', { count: diffDays });
    }
}

function formatTime(ts?: number): string | null {
    if (!ts) return null;
    try {
        return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
        return null;
    }
}

function groupClaudeSessionsByDate(sessions: ClaudeSessionIndexEntry[]): ClaudeHistoryGroup[] {
    const sorted = sessions
        .slice()
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    const groups: ClaudeHistoryGroup[] = [];
    let currentKey: string | null = null;
    let currentEntries: ClaudeSessionIndexEntry[] = [];

    const flush = () => {
        if (!currentEntries.length || !currentKey) return;
        const label = currentKey === 'unknown'
            ? t('message.unknownTime')
            : formatDateHeader(new Date(currentKey));
        groups.push({ key: currentKey, label, entries: currentEntries });
    };

    for (const entry of sorted) {
        const dateKey = entry.updatedAt ? new Date(entry.updatedAt).toDateString() : 'unknown';
        if (currentKey !== dateKey) {
            flush();
            currentKey = dateKey;
            currentEntries = [entry];
        } else {
            currentEntries.push(entry);
        }
    }

    flush();
    return groups;
}

function getClaudeSessionTitle(entry: ClaudeSessionIndexEntry): string {
    const title = entry.title?.trim();
    if (title) return title;
    if (entry.originalPath) {
        const parts = entry.originalPath.split(/[\\/]/).filter(Boolean);
        if (parts.length > 0) {
            return parts[parts.length - 1];
        }
        return entry.originalPath;
    }
    return t('machine.untitledSession');
}

export default function ClaudeSessionHistory() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const machines = useAllMachines();
    const pageSize = 50;
    const loadMoreInFlightRef = React.useRef(false);
    const lastRequestedOffsetRef = React.useRef<number | null>(null);
    const [selectedMachineId, setSelectedMachineId] = React.useState<string | null>(null);
    const [sessions, setSessions] = React.useState<ClaudeSessionIndexEntry[] | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [loadingMore, setLoadingMore] = React.useState(false);
    const [totalCount, setTotalCount] = React.useState<number | null>(null);
    const [resumingSessionId, setResumingSessionId] = React.useState<string | null>(null);

    // Preview sheet state
    const [previewEntry, setPreviewEntry] = React.useState<ClaudeSessionIndexEntry | null>(null);
    const [previewMessages, setPreviewMessages] = React.useState<ClaudeSessionPreviewMessage[] | null>(null);
    const [previewLoading, setPreviewLoading] = React.useState(false);
    const lastPreviewSessionIdRef = React.useRef<string | null>(null);
    const selectedMachine = React.useMemo(
        () => machines.find((machine) => machine.id === selectedMachineId) || null,
        [machines, selectedMachineId]
    );
    const groupedSessions = React.useMemo(() => {
        if (!sessions) return [];
        return groupClaudeSessionsByDate(sessions);
    }, [sessions]);
    const hasMore = React.useMemo(() => {
        if (totalCount == null || !sessions) return false;
        return sessions.length < totalCount;
    }, [sessions, totalCount]);

    React.useEffect(() => {
        if (!selectedMachineId && machines.length > 0) {
            const savedMachineId = mmkv.getString(SELECTED_MACHINE_KEY);
            const savedMachineExists = savedMachineId && machines.some(m => m.id === savedMachineId);
            setSelectedMachineId(savedMachineExists ? savedMachineId : machines[0].id);
        }
    }, [machines, selectedMachineId]);

    React.useEffect(() => {
        if (selectedMachineId) {
            mmkv.set(SELECTED_MACHINE_KEY, selectedMachineId);
        }
    }, [selectedMachineId]);

    React.useEffect(() => {
        if (!selectedMachineId) {
            setSessions(null);
            setTotalCount(null);
            return;
        }

        let isMounted = true;
        setLoading(true);
        setLoadingMore(false);
        machineListClaudeSessions(selectedMachineId, { offset: 0, limit: pageSize })
            .then((data) => {
                if (!isMounted) return;
                setSessions(data.sessions);
                setTotalCount(data.total);
            })
            .catch((error) => {
                if (!isMounted) return;
                console.error('Failed to load Claude sessions', error);
                Modal.alert(t('common.error'), t('claudeHistory.loadFailed'));
                setSessions([]);
                setTotalCount(0);
            })
            .finally(() => {
                if (!isMounted) return;
                setLoading(false);
            });

        return () => {
            isMounted = false;
        };
    }, [selectedMachineId]);

    const handleLoadMore = React.useCallback(() => {
        if (!selectedMachineId || loading || loadingMore || !sessions || !hasMore) {
            return;
        }
        if (loadMoreInFlightRef.current) {
            return;
        }
        const offset = sessions.length;
        if (lastRequestedOffsetRef.current === offset) {
            return;
        }
        loadMoreInFlightRef.current = true;
        lastRequestedOffsetRef.current = offset;
        setLoadingMore(true);
        machineListClaudeSessions(selectedMachineId, {
            offset,
            limit: pageSize
        })
            .then((data) => {
                setSessions((prev) => {
                    if (!prev) return data.sessions;
                    return prev.concat(data.sessions);
                });
                setTotalCount(data.total);
            })
            .catch((error) => {
                console.error('Failed to load more Claude sessions', error);
            })
            .finally(() => {
                setLoadingMore(false);
                loadMoreInFlightRef.current = false;
            });
    }, [selectedMachineId, sessions, hasMore, loading, loadingMore, pageSize]);

    const handleScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        if (!hasMore || loadingMore || loading) return;
        const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
        const paddingToBottom = 120;
        if (layoutMeasurement.height + contentOffset.y >= contentSize.height - paddingToBottom) {
            handleLoadMore();
        }
    }, [hasMore, loadingMore, loading, handleLoadMore]);

    const handleOpenPreview = React.useCallback(async (entry: ClaudeSessionIndexEntry) => {
        if (!selectedMachineId) return;

        const isSameSession = lastPreviewSessionIdRef.current === entry.sessionId;

        // Show the sheet immediately
        setPreviewEntry(entry);

        // If reopening the same session and we have cached messages, use them
        if (isSameSession && previewMessages !== null) {
            return;
        }

        // Clear messages and start loading for new session
        lastPreviewSessionIdRef.current = entry.sessionId;
        setPreviewMessages(null);
        setPreviewLoading(true);

        // Record start time for animation sync
        // Spring animation with damping=20, stiffness=300 takes ~400ms to visually settle
        const startTime = Date.now();
        const animationDuration = 700;

        // Start loading data in parallel with animation
        try {
            const result = await machineGetClaudeSessionPreview(
                selectedMachineId,
                entry.projectId,
                entry.sessionId,
                { limit: 10 }
            );

            // Calculate how long to wait before showing data
            const elapsed = Date.now() - startTime;
            const remainingDelay = Math.max(0, animationDuration - elapsed);

            if (remainingDelay > 0) {
                // Wait for animation to complete
                await new Promise(resolve => setTimeout(resolve, remainingDelay));
            }

            setPreviewMessages(result.messages);
        } catch (error) {
            console.error('Failed to load preview', error);
            // Still wait for animation if needed
            const elapsed = Date.now() - startTime;
            const remainingDelay = Math.max(0, animationDuration - elapsed);
            if (remainingDelay > 0) {
                await new Promise(resolve => setTimeout(resolve, remainingDelay));
            }
            setPreviewMessages([]);
        } finally {
            setPreviewLoading(false);
        }
    }, [selectedMachineId, previewMessages]);

    const handleClosePreview = React.useCallback(() => {
        // Only set entry to null to trigger close animation
        // Keep messages cached for potential reopening of same session
        setPreviewEntry(null);
    }, []);

    const handleResume = React.useCallback(async (entry: ClaudeSessionIndexEntry) => {
        if (!selectedMachineId || resumingSessionId) return;
        if (!entry.originalPath) {
            Modal.alert(t('common.error'), t('claudeHistory.pathUnavailable'));
            return;
        }
        const confirmed = await Modal.confirm(
            t('sessionHistory.resumeConfirmTitle'),
            t('sessionHistory.resumeConfirmMessage'),
            { confirmText: t('common.continue'), cancelText: t('common.cancel') }
        );
        if (!confirmed) return;

        setResumingSessionId(entry.sessionId);
        try {
            const sessionTitle = entry.title?.trim();
            const forkResult = await machineForkClaudeSession(selectedMachineId, entry.sessionId);
            if (!forkResult.success || !forkResult.newSessionId) {
                Modal.alert(t('common.error'), forkResult.errorMessage || t('claudeHistory.resumeFailed'));
                return;
            }
            const result = await machineSpawnNewSession({
                machineId: selectedMachineId,
                directory: entry.originalPath,
                approvedNewDirectoryCreation: false,
                agent: 'claude',
                resumeSessionId: forkResult.newSessionId,
                sessionTitle: sessionTitle || undefined,
                skipForkSession: true,
            });

            if (result.type === 'requestToApproveDirectoryCreation') {
                Modal.alert(t('common.error'), t('claudeHistory.directoryNotFound'));
                return;
            }

            if (result.type === 'error') {
                Modal.alert(t('common.error'), result.errorMessage || t('claudeHistory.resumeFailed'));
                return;
            }

            if (result.type === 'success') {
                await sync.refreshSessions();
                router.push(`/session/${result.sessionId}`, {
                    dangerouslySingular() {
                        return 'session';
                    },
                });
            }
        } catch (error) {
            console.error('Failed to resume session', error);
            Modal.alert(t('common.error'), t('claudeHistory.resumeFailed'));
        } finally {
            setResumingSessionId(null);
        }
    }, [selectedMachineId, resumingSessionId, router]);

    const handleResumeFromPreview = React.useCallback(() => {
        if (previewEntry) {
            handleClosePreview();
            handleResume(previewEntry);
        }
    }, [previewEntry, handleClosePreview, handleResume]);

    return (
        <ItemList style={{ paddingTop: 0 }} onScroll={handleScroll} scrollEventThrottle={200}>
            <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                {(machines.length === 0 || machines.length > 1) && (
                    <ItemGroup title={t('settings.machines')}>
                        {machines.length === 0 && (
                            <Item
                                title={t('claudeHistory.noMachines')}
                                icon={<Ionicons name="desktop-outline" size={29} color={theme.colors.textSecondary} />}
                                showChevron={false}
                            />
                        )}
                        {machines.length > 1 && machines.map((machine) => {
                            const isOnline = isMachineOnline(machine);
                            const host = machine.metadata?.host || 'Unknown';
                            const displayName = machine.metadata?.displayName;
                            const platform = machine.metadata?.platform || '';

                            const title = displayName || host;
                            let subtitle = '';
                            if (displayName && displayName !== host) {
                                subtitle = host;
                            }
                            if (platform) {
                                subtitle = subtitle ? `${subtitle} • ${platform}` : platform;
                            }
                            subtitle = subtitle ? `${subtitle} • ${isOnline ? t('status.online') : t('status.offline')}` : (isOnline ? t('status.online') : t('status.offline'));

                            return (
                                <Item
                                    key={machine.id}
                                    title={title}
                                    subtitle={subtitle}
                                    selected={machine.id === selectedMachineId}
                                    showChevron={false}
                                    icon={
                                        <Ionicons
                                            name="desktop-outline"
                                            size={29}
                                            color={isOnline ? theme.colors.status.connected : theme.colors.status.disconnected}
                                        />
                                    }
                                    onPress={() => setSelectedMachineId(machine.id)}
                                />
                            );
                        })}
                    </ItemGroup>
                )}

                {(loading || (sessions && sessions.length === 0)) && (
                    <ItemGroup title={t('claudeHistory.title')}>
                        {loading && (
                            <View style={{ paddingVertical: 24, alignItems: 'center' }}>
                                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                            </View>
                        )}
                        {!loading && sessions && sessions.length === 0 && (
                            <View style={{ paddingVertical: 24, paddingHorizontal: 16 }}>
                                <Text style={{ color: theme.colors.textSecondary }}>
                                    {t('claudeHistory.empty')}
                                </Text>
                            </View>
                        )}
                    </ItemGroup>
                )}

                {!loading && groupedSessions.map((group) => (
                    <ItemGroup key={`date-${group.key}`} title={group.label}>
                        {group.entries.map((entry) => {
                            const time = formatTime(entry.updatedAt);
                            const displayPath = entry.originalPath
                                ? formatPathRelativeToHome(entry.originalPath, selectedMachine?.metadata?.homeDir)
                                : t('claudeHistory.pathUnavailable');
                            const msgCount = entry.messageCount ? `${entry.messageCount} messages` : null;
                            const line2Parts = [time, msgCount, entry.gitBranch].filter(Boolean);
                            const line2 = line2Parts.join(' • ');
                            const subtitle = line2 ? `${displayPath}\n${line2}` : displayPath;
                            const title = getClaudeSessionTitle(entry);

                            const isResuming = resumingSessionId === entry.sessionId;
                            return (
                                <Item
                                    key={`${entry.projectId}-${entry.sessionId}`}
                                    title={title}
                                    subtitle={subtitle}
                                    subtitleLines={2}
                                    disabled={!entry.originalPath || resumingSessionId !== null}
                                    showChevron={false}
                                    titleStyle={{
                                        fontSize: 15,
                                        fontWeight: '500',
                                    }}
                                    subtitleStyle={{
                                        fontSize: 13,
                                        lineHeight: 16,
                                    }}
                                    iconContainerStyle={{ 
                                        width: 48, 
                                        height: 48,
                                        marginRight: 16
                                    }}
                                    icon={(
                                        <Image
                                            source={require('@/assets/images/icon-claude.png')}
                                            style={{ width: 48, height: 48 }}
                                            contentFit="contain"
                                        />
                                    )}
                                    rightElement={!isResuming ? (
                                        <Pressable
                                            style={rightIconStyle}
                                            onPress={(event) => {
                                                event.stopPropagation?.();
                                                handleResume(entry);
                                            }}
                                        >
                                            <Ionicons
                                                name="play-circle-outline"
                                                size={29}
                                                color={theme.colors.groupped.chevron}
                                            />
                                        </Pressable>
                                    ) : (
                                        <View style={rightIconStyle}>
                                            <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                                        </View>
                                    )}
                                    onPress={() => handleOpenPreview(entry)}
                                />
                            );
                        })}
                    </ItemGroup>
                ))}
                {loadingMore && (
                    <View style={{ paddingVertical: 16, alignItems: 'center' }}>
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    </View>
                )}
            </View>

            <SessionPreviewSheet
                visible={previewEntry !== null}
                entry={previewEntry}
                messages={previewMessages}
                loading={previewLoading}
                onClose={handleClosePreview}
                onResume={handleResumeFromPreview}
            />
        </ItemList>
    );
}
