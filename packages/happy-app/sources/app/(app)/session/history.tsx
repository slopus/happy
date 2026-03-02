import React from 'react';
import { View, ActivityIndicator, NativeScrollEvent, NativeSyntheticEvent, Pressable, TextInput } from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Text } from '@/components/StyledText';
import { useAllMachines } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import {
    machineListClaudeSessions,
    machineSpawnNewSession,
    machineGetClaudeSessionPreview,
    machineForkClaudeSession,
    machineListGeminiSessions,
    machineGetGeminiSessionPreview,
    machineForkGeminiSession,
    machineListCodexSessions,
    machineGetCodexSessionPreview,
    machineForkCodexSession,
    AgentSessionIndexEntry,
    ClaudeSessionPreviewMessage,
} from '@/sync/ops';
import { SessionPreviewSheet } from '@/components/SessionPreviewSheet';
import { Modal } from '@/modal';
import { useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { t } from '@/text';
import { sync } from '@/sync/sync';
import { formatPathRelativeToHome } from '@/utils/sessionUtils';
import { MMKV } from 'react-native-mmkv';

const mmkv = new MMKV();
const SELECTED_MACHINE_KEY = 'agent-history-selected-machine';
const SELECTED_TAB_KEY = 'agent-history-selected-tab';

type AgentTab = 'claude' | 'gemini' | 'codex';

const AGENT_TABS: { key: AgentTab; label: () => string }[] = [
    { key: 'claude', label: () => t('agentHistory.tabClaude') },
    { key: 'gemini', label: () => t('agentHistory.tabGemini') },
    { key: 'codex', label: () => t('agentHistory.tabCodex') },
];

const agentIcons: Record<AgentTab, any> = {
    claude: require('@/assets/images/icon-claude.png'),
    gemini: require('@/assets/images/icon-gemini.png'),
    codex: require('@/assets/images/icon-gpt.png'),
};

const rightIconStyle = {
    width: 29,
    height: 29,
    alignItems: 'center',
    justifyContent: 'center',
} as const;

type HistoryGroup = {
    key: string;
    label: string;
    entries: AgentSessionIndexEntry[];
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

function groupSessionsByDate(sessions: AgentSessionIndexEntry[]): HistoryGroup[] {
    const sorted = sessions
        .slice()
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    const groups: HistoryGroup[] = [];
    let currentKey: string | null = null;
    let currentEntries: AgentSessionIndexEntry[] = [];

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

function getSessionTitle(entry: AgentSessionIndexEntry): string {
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

export default function AgentHistoryPage() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const machines = useAllMachines();
    const pageSize = 50;
    const loadMoreInFlightRef = React.useRef(false);
    const lastRequestedOffsetRef = React.useRef<number | null>(null);

    const [activeTab, setActiveTab] = React.useState<AgentTab>(() => {
        const saved = mmkv.getString(SELECTED_TAB_KEY);
        if (saved === 'claude' || saved === 'gemini' || saved === 'codex') return saved;
        return 'claude';
    });
    const [selectedMachineId, setSelectedMachineId] = React.useState<string | null>(null);
    const [sessions, setSessions] = React.useState<AgentSessionIndexEntry[] | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [loadingMore, setLoadingMore] = React.useState(false);
    const [totalCount, setTotalCount] = React.useState<number | null>(null);
    const [resumingSessionId, setResumingSessionId] = React.useState<string | null>(null);
    const [searchQuery, setSearchQuery] = React.useState('');
    const [searchTrigger, setSearchTrigger] = React.useState(0);
    const searchDebounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    // Preview sheet state
    const [previewEntry, setPreviewEntry] = React.useState<AgentSessionIndexEntry | null>(null);
    const [previewMessages, setPreviewMessages] = React.useState<ClaudeSessionPreviewMessage[] | null>(null);
    const [previewLoading, setPreviewLoading] = React.useState(false);
    const lastPreviewSessionIdRef = React.useRef<string | null>(null);

    const selectedMachine = React.useMemo(
        () => machines.find((machine) => machine.id === selectedMachineId) || null,
        [machines, selectedMachineId]
    );
    const groupedSessions = React.useMemo(() => {
        if (!sessions) return [];
        return groupSessionsByDate(sessions);
    }, [sessions]);
    const hasMore = React.useMemo(() => {
        if (totalCount == null || !sessions) return false;
        return sessions.length < totalCount;
    }, [sessions, totalCount]);

    // Machine selection persistence
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

    // Tab persistence
    React.useEffect(() => {
        mmkv.set(SELECTED_TAB_KEY, activeTab);
    }, [activeTab]);

    // Clean up debounce timer on unmount
    React.useEffect(() => {
        return () => {
            if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
        };
    }, []);

    // Load sessions when tab or machine changes
    React.useEffect(() => {
        if (!selectedMachineId) {
            setSessions(null);
            setTotalCount(null);
            return;
        }

        let isMounted = true;
        setLoading(true);
        setLoadingMore(false);
        loadMoreInFlightRef.current = false;
        lastRequestedOffsetRef.current = null;

        // Clear preview state on tab change
        setPreviewEntry(null);
        setPreviewMessages(null);
        lastPreviewSessionIdRef.current = null;

        const loadSessions = async () => {
            try {
                let data: { sessions: any[]; total: number; fromCache?: boolean };

                if (activeTab === 'claude') {
                    data = await machineListClaudeSessions(selectedMachineId, { offset: 0, limit: pageSize, query: searchQuery || undefined });
                } else if (activeTab === 'gemini') {
                    data = await machineListGeminiSessions(selectedMachineId, { offset: 0, limit: pageSize, query: searchQuery || undefined });
                } else {
                    data = await machineListCodexSessions(selectedMachineId, { offset: 0, limit: pageSize, query: searchQuery || undefined });
                }
                if (!isMounted) return;

                // Map Claude entries to include agent field
                const mapped: AgentSessionIndexEntry[] = activeTab === 'claude'
                    ? data.sessions.map((s: any) => ({ ...s, agent: 'claude' as const }))
                    : data.sessions;
                setSessions(mapped);
                setTotalCount(data.total);
                setLoading(false);

                // If data was from cache, request fresh data in background
                if (data.fromCache) {
                    let freshData: { sessions: any[]; total: number; fromCache?: boolean };
                    if (activeTab === 'claude') {
                        freshData = await machineListClaudeSessions(selectedMachineId, { offset: 0, limit: pageSize, query: searchQuery || undefined, waitForRefresh: true });
                    } else if (activeTab === 'gemini') {
                        freshData = await machineListGeminiSessions(selectedMachineId, { offset: 0, limit: pageSize, query: searchQuery || undefined, waitForRefresh: true });
                    } else {
                        freshData = await machineListCodexSessions(selectedMachineId, { offset: 0, limit: pageSize, query: searchQuery || undefined, waitForRefresh: true });
                    }
                    if (!isMounted) return;
                    const freshMapped: AgentSessionIndexEntry[] = activeTab === 'claude'
                        ? freshData.sessions.map((s: any) => ({ ...s, agent: 'claude' as const }))
                        : freshData.sessions;
                    setSessions(freshMapped);
                    setTotalCount(freshData.total);
                }
            } catch (error) {
                if (!isMounted) return;
                console.error(`Failed to load ${activeTab} sessions`, error);
                Modal.alert(t('common.error'), t('agentHistory.loadFailed'));
                setSessions([]);
                setTotalCount(0);
                setLoading(false);
            }
        };

        loadSessions();
        return () => { isMounted = false; };
    }, [selectedMachineId, activeTab, searchTrigger]);

    // Load more (pagination)
    const handleLoadMore = React.useCallback(() => {
        if (!selectedMachineId || loading || loadingMore || !sessions || !hasMore) return;
        if (loadMoreInFlightRef.current) return;
        const offset = sessions.length;
        if (lastRequestedOffsetRef.current === offset) return;

        loadMoreInFlightRef.current = true;
        lastRequestedOffsetRef.current = offset;
        setLoadingMore(true);

        const loadMore = async () => {
            try {
                if (activeTab === 'claude') {
                    const data = await machineListClaudeSessions(selectedMachineId, { offset, limit: pageSize, query: searchQuery || undefined });
                    const mapped: AgentSessionIndexEntry[] = data.sessions.map(s => ({
                        sessionId: s.sessionId,
                        agent: 'claude' as const,
                        originalPath: s.originalPath,
                        title: s.title,
                        updatedAt: s.updatedAt,
                        messageCount: s.messageCount,
                        gitBranch: s.gitBranch,
                        projectId: s.projectId,
                    }));
                    setSessions(prev => prev ? prev.concat(mapped) : mapped);
                    setTotalCount(data.total);
                } else if (activeTab === 'gemini') {
                    const data = await machineListGeminiSessions(selectedMachineId, { offset, limit: pageSize, query: searchQuery || undefined });
                    setSessions(prev => prev ? prev.concat(data.sessions) : data.sessions);
                    setTotalCount(data.total);
                } else {
                    const data = await machineListCodexSessions(selectedMachineId, { offset, limit: pageSize, query: searchQuery || undefined });
                    setSessions(prev => prev ? prev.concat(data.sessions) : data.sessions);
                    setTotalCount(data.total);
                }
            } catch (error) {
                console.error(`Failed to load more ${activeTab} sessions`, error);
            } finally {
                setLoadingMore(false);
                loadMoreInFlightRef.current = false;
            }
        };

        loadMore();
    }, [selectedMachineId, sessions, hasMore, loading, loadingMore, activeTab, pageSize, searchQuery]);

    const handleScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        if (!hasMore || loadingMore || loading) return;
        const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
        const paddingToBottom = 120;
        if (layoutMeasurement.height + contentOffset.y >= contentSize.height - paddingToBottom) {
            handleLoadMore();
        }
    }, [hasMore, loadingMore, loading, handleLoadMore]);

    // Preview
    const handleOpenPreview = React.useCallback(async (entry: AgentSessionIndexEntry) => {
        if (!selectedMachineId) return;

        const isSameSession = lastPreviewSessionIdRef.current === entry.sessionId;
        setPreviewEntry(entry);

        if (isSameSession && previewMessages !== null) return;

        lastPreviewSessionIdRef.current = entry.sessionId;
        setPreviewMessages(null);
        setPreviewLoading(true);

        const startTime = Date.now();
        const animationDuration = 700;

        try {
            let result: { messages: ClaudeSessionPreviewMessage[] };

            if (entry.agent === 'claude' && entry.projectId) {
                result = await machineGetClaudeSessionPreview(
                    selectedMachineId, entry.projectId, entry.sessionId, { limit: 10 }
                );
            } else if (entry.agent === 'gemini') {
                result = await machineGetGeminiSessionPreview(
                    selectedMachineId, entry.sessionId, { limit: 10 }
                );
            } else {
                result = await machineGetCodexSessionPreview(
                    selectedMachineId, entry.sessionId, { limit: 10 }
                );
            }

            const elapsed = Date.now() - startTime;
            const remainingDelay = Math.max(0, animationDuration - elapsed);
            if (remainingDelay > 0) {
                await new Promise(resolve => setTimeout(resolve, remainingDelay));
            }

            setPreviewMessages(result.messages);
        } catch (error) {
            console.error('Failed to load preview', error);
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
        setPreviewEntry(null);
    }, []);

    // Resume
    const handleResume = React.useCallback(async (entry: AgentSessionIndexEntry) => {
        if (!selectedMachineId || resumingSessionId) return;
        if (!entry.originalPath) {
            Modal.alert(t('common.error'), t('claudeHistory.pathUnavailable'));
            return;
        }
        const provider = entry.agent === 'gemini' ? 'Gemini' : entry.agent === 'codex' ? 'Codex' : 'Claude';
        const confirmed = await Modal.confirm(
            t('sessionHistory.resumeConfirmTitle'),
            t('sessionHistory.resumeConfirmMessage', { provider }),
            { confirmText: t('common.continue'), cancelText: t('common.cancel') }
        );
        if (!confirmed) return;

        setResumingSessionId(entry.sessionId);
        try {
            const sessionTitle = entry.title?.trim();
            let resumeSessionId: string | undefined;
            const agent = entry.agent;

            if (agent === 'claude') {
                const forkResult = await machineForkClaudeSession(selectedMachineId, entry.sessionId);
                if (!forkResult.success || !forkResult.newSessionId) {
                    Modal.alert(t('common.error'), forkResult.errorMessage || t('agentHistory.resumeFailed'));
                    return;
                }
                resumeSessionId = forkResult.newSessionId;
            } else if (agent === 'gemini') {
                const forkResult = await machineForkGeminiSession(selectedMachineId, entry.sessionId);
                if (!forkResult.success || !forkResult.newSessionId) {
                    Modal.alert(t('common.error'), forkResult.errorMessage || t('agentHistory.resumeFailed'));
                    return;
                }
                resumeSessionId = forkResult.newSessionId;
            } else {
                const forkResult = await machineForkCodexSession(selectedMachineId, entry.sessionId);
                if (!forkResult.success || !forkResult.newFilePath) {
                    Modal.alert(t('common.error'), forkResult.errorMessage || t('agentHistory.resumeFailed'));
                    return;
                }
                resumeSessionId = forkResult.newFilePath;
            }

            const result = await machineSpawnNewSession({
                machineId: selectedMachineId,
                directory: entry.originalPath,
                approvedNewDirectoryCreation: false,
                agent,
                resumeSessionId,
                sessionTitle: sessionTitle || undefined,
                skipForkSession: true,
            });

            if (result.type === 'requestToApproveDirectoryCreation') {
                Modal.alert(t('common.error'), t('claudeHistory.directoryNotFound'));
                return;
            }

            if (result.type === 'error') {
                Modal.alert(t('common.error'), result.errorMessage || t('agentHistory.resumeFailed'));
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
            Modal.alert(t('common.error'), t('agentHistory.resumeFailed'));
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
                {/* Machine picker */}
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
                                subtitle = subtitle ? `${subtitle} \u2022 ${platform}` : platform;
                            }
                            subtitle = subtitle
                                ? `${subtitle} \u2022 ${isOnline ? t('status.online') : t('status.offline')}`
                                : (isOnline ? t('status.online') : t('status.offline'));

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

                {/* Tab selector */}
                <View style={{
                    flexDirection: 'row',
                    marginHorizontal: 16,
                    marginTop: 16,
                    marginBottom: 8,
                    backgroundColor: theme.colors.groupped.background,
                    borderRadius: 10,
                    padding: 3,
                }}>
                    {AGENT_TABS.map((tab) => {
                        const isActive = activeTab === tab.key;
                        return (
                            <Pressable
                                key={tab.key}
                                onPress={() => { setActiveTab(tab.key); setSearchQuery(''); }}
                                style={{
                                    flex: 1,
                                    paddingVertical: 8,
                                    borderRadius: 8,
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    backgroundColor: isActive ? theme.colors.surface : 'transparent',
                                }}
                            >
                                <Text style={{
                                    fontSize: 14,
                                    fontWeight: isActive ? '600' : '400',
                                    color: isActive ? theme.colors.text : theme.colors.textSecondary,
                                }}>
                                    {tab.label()}
                                </Text>
                            </Pressable>
                        );
                    })}
                </View>

                {/* Search bar */}
                <View style={{
                    marginHorizontal: 16,
                    marginBottom: 8,
                }}>
                    <View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        backgroundColor: theme.colors.groupped.background,
                        borderRadius: 10,
                        paddingHorizontal: 12,
                        height: 36,
                    }}>
                        <Ionicons name="search-outline" size={16} color={theme.colors.textSecondary} />
                        <TextInput
                            style={{
                                flex: 1,
                                marginLeft: 8,
                                fontSize: 14,
                                color: theme.colors.text,
                                padding: 0,
                            }}
                            placeholder={t('agentHistory.searchPlaceholder')}
                            placeholderTextColor={theme.colors.textSecondary}
                            value={searchQuery}
                            onChangeText={(text) => {
                                setSearchQuery(text);
                                if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
                                searchDebounceRef.current = setTimeout(() => {
                                    setSearchTrigger(prev => prev + 1);
                                }, 300);
                            }}
                            returnKeyType="search"
                            autoCapitalize="none"
                            autoCorrect={false}
                        />
                        {searchQuery.length > 0 && (
                            <Pressable onPress={() => {
                                setSearchQuery('');
                                setSearchTrigger(prev => prev + 1);
                            }}>
                                <Ionicons name="close-circle" size={16} color={theme.colors.textSecondary} />
                            </Pressable>
                        )}
                    </View>
                </View>

                {/* Loading / empty state */}
                {(loading || (sessions && sessions.length === 0)) && (
                    <ItemGroup title={t('agentHistory.title')}>
                        {loading && (
                            <View style={{ paddingVertical: 24, alignItems: 'center' }}>
                                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                            </View>
                        )}
                        {!loading && sessions && sessions.length === 0 && (
                            <View style={{ paddingVertical: 24, paddingHorizontal: 16 }}>
                                <Text style={{ color: theme.colors.textSecondary }}>
                                    {t('agentHistory.empty')}
                                </Text>
                            </View>
                        )}
                    </ItemGroup>
                )}

                {/* Session list grouped by date */}
                {!loading && groupedSessions.map((group) => (
                    <ItemGroup key={`date-${group.key}`} title={group.label}>
                        {group.entries.map((entry, entryIndex) => {
                            const time = formatTime(entry.updatedAt);
                            const displayPath = entry.originalPath
                                ? formatPathRelativeToHome(entry.originalPath, selectedMachine?.metadata?.homeDir)
                                : t('claudeHistory.pathUnavailable');
                            const shortHash = entry.sessionId.substring(0, 6);
                            const msgCount = entry.messageCount ? `${entry.messageCount} messages` : null;
                            const line2Parts = [time, msgCount, shortHash, entry.gitBranch].filter(Boolean);
                            const line2 = line2Parts.join(' \u2022 ');
                            const subtitle = line2 ? `${displayPath}\n${line2}` : displayPath;
                            const title = getSessionTitle(entry);

                            const isResuming = resumingSessionId === entry.sessionId;
                            return (
                                <Item
                                    key={`${entry.agent}-${entry.sessionId}-${entryIndex}`}
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
                                            source={agentIcons[entry.agent]}
                                            style={[
                                                { width: 48, height: 48 },
                                                entry.agent === 'codex' && { transform: [{ scale: 0.92 }] }
                                            ]}
                                            contentFit="contain"
                                            tintColor={entry.agent === 'codex' ? theme.colors.text : undefined}
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
