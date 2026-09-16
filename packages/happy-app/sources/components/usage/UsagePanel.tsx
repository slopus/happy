import React, { useState, useEffect, useRef } from 'react';
import { View, ActivityIndicator, Platform, ScrollView, Pressable } from 'react-native';
import { Text } from '@/components/StyledText';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useAuth } from '@/auth/AuthContext';
import { ItemGroup } from '@/components/ItemGroup';
import { UsageChart } from './UsageChart';
import { UsageBar } from './UsageBar';
import { getUsageForPeriod, calculateTotals, UsageDataPoint } from '@/sync/apiUsage';
import { Ionicons } from '@expo/vector-icons';
import { HappyError } from '@/utils/errors';
import { getCurrentLanguage, t } from '@/text';
import { storage, useAllMachines } from '@/sync/storage';
import { apiSocket } from '@/sync/apiSocket';
import { useCodexAccounts } from '@/hooks/useCodexAccounts';
import type { CodexAccountProfile } from '@/sync/apiCodexAccounts';

type TimePeriod = 'today' | '7days' | '30days';

interface CodexUsageSnapshot {
    source: 'codex-session-jsonl';
    scannedAt: number;
    timeZone?: string;
    days?: CodexUsageDay[];
}

interface CodexUsageDay {
    date: string;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
    tokenCountEvents: number;
    sessions: number;
    totalOnlyTokens: number;
}

const CODEX_HEATMAP_DAYS = 365;
const CODEX_HEATMAP_CELL_SIZE = 14;
const CODEX_USAGE_REFRESH_RPC_TIMEOUT_MS = 60_000;

function getCodexUsageSnapshot(daemonState: unknown): CodexUsageSnapshot | null {
    if (!daemonState || typeof daemonState !== 'object') {
        return null;
    }
    const snapshot = (daemonState as { codexUsage?: unknown }).codexUsage;
    if (!snapshot || typeof snapshot !== 'object') {
        return null;
    }
    const candidate = snapshot as Partial<CodexUsageSnapshot>;
    if (candidate.source !== 'codex-session-jsonl' || typeof candidate.scannedAt !== 'number') {
        return null;
    }
    return candidate as CodexUsageSnapshot;
}

function dateKeyForTimeZone(timestamp: number, timeZone?: string): string {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(new Date(timestamp)).reduce<Record<string, string>>((result, part) => {
        result[part.type] = part.value;
        return result;
    }, {});
    return `${parts.year}-${parts.month}-${parts.day}`;
}

function getCodexHeatmapDays(snapshot: CodexUsageSnapshot | null): CodexUsageDay[] {
    if (!snapshot?.days?.length) {
        return [];
    }
    const daysByDate = new Map(snapshot.days.map((day) => [day.date, day]));
    const endDate = new Date(`${dateKeyForTimeZone(snapshot.scannedAt, snapshot.timeZone)}T00:00:00.000Z`);

    return Array.from({ length: CODEX_HEATMAP_DAYS }, (_, index) => {
        const day = new Date(endDate);
        day.setUTCDate(day.getUTCDate() - (CODEX_HEATMAP_DAYS - index - 1));
        const date = day.toISOString().slice(0, 10);
        return daysByDate.get(date) || {
            date,
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: 0,
            tokenCountEvents: 0,
            sessions: 0,
            totalOnlyTokens: 0,
        };
    });
}

function getCodexHeatmapWeeks(days: CodexUsageDay[]): Array<Array<CodexUsageDay | null>> {
    if (days.length === 0) {
        return [];
    }
    const paddedDays: Array<CodexUsageDay | null> = [
        ...Array.from({ length: new Date(`${days[0].date}T00:00:00.000Z`).getUTCDay() }, () => null),
        ...days,
    ];
    while (paddedDays.length % 7 !== 0) {
        paddedDays.push(null);
    }
    return Array.from({ length: paddedDays.length / 7 }, (_, index) => (
        paddedDays.slice(index * 7, (index + 1) * 7)
    ));
}

function getCodexHeatmapMonthLabels(weeks: Array<Array<CodexUsageDay | null>>, locale: string): Array<{
    key: string;
    label: string;
    weekIndex: number;
}> {
    const formatter = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' });
    const labelsByWeek = new Map<number, { key: string; label: string; weekIndex: number }>();
    weeks.forEach((week, weekIndex) => {
        const monthStart = week.find((day): day is CodexUsageDay => day?.date.endsWith('-01') === true);
        if (!monthStart) return;
        labelsByWeek.set(weekIndex, {
            key: monthStart.date.slice(0, 7),
            label: formatter.format(new Date(`${monthStart.date}T00:00:00.000Z`)),
            weekIndex,
        });
    });
    const firstDay = weeks[0]?.find((day): day is CodexUsageDay => !!day);
    if (firstDay && !labelsByWeek.has(0)) {
        labelsByWeek.set(0, {
            key: firstDay.date.slice(0, 7),
            label: formatter.format(new Date(`${firstDay.date}T00:00:00.000Z`)),
            weekIndex: 0,
        });
    }
    return [...labelsByWeek.values()].sort((a, b) => a.weekIndex - b.weekIndex);
}

function getCodexHeatmapOpacity(totalTokens: number, maxTokens: number): number {
    const normalized = Math.sqrt(totalTokens / Math.max(maxTokens, 1));
    if (normalized <= 0.25) return 0.28;
    if (normalized <= 0.5) return 0.5;
    if (normalized <= 0.75) return 0.72;
    return 1;
}

function formatCodexActivityTokens(tokens: number, language: string): string {
    if (language === 'zh-Hans') {
        return `${(tokens / 100_000_000).toFixed(2)} 亿`;
    }
    if (language === 'zh-Hant') {
        return `${(tokens / 100_000_000).toFixed(2)} 億`;
    }
    if (tokens >= 1_000_000) {
        return `${(tokens / 1_000_000).toFixed(2)}M`;
    }
    if (tokens >= 1_000) {
        return `${(tokens / 1_000).toFixed(1)}K`;
    }
    return tokens.toLocaleString();
}

interface CodexRateLimitSummary {
    period: string;
    used: number;
    remaining: number;
    resetAt: string;
}

function getCodexAccountQuotaSummary(profile: CodexAccountProfile | undefined): CodexRateLimitSummary | null {
    if (!profile || typeof profile.quota.remainingPercent !== 'number') return null;
    const remaining = profile.quota.remainingPercent;
    const resetAt = profile.quota.weeklyResetsAt;
    if (resetAt && Date.parse(resetAt) <= Date.now()) return null;
    return {
        period: '7d',
        used: 100 - remaining,
        remaining,
        resetAt: resetAt ? new Date(resetAt).toLocaleString() : t('common.unknown'),
    };
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
    },
    periodSelector: {
        flexDirection: 'row',
        padding: 16,
        gap: 8,
    },
    periodButton: {
        flex: 1,
        paddingVertical: 8,
        paddingHorizontal: 12,
        borderRadius: 8,
        backgroundColor: theme.colors.surface,
        alignItems: 'center',
    },
    periodButtonActive: {
        backgroundColor: theme.colors.accent,
    },
    periodText: {
        fontSize: 14,
        color: theme.colors.text,
        fontWeight: '500',
    },
    periodTextActive: {
        color: '#FFFFFF',
    },
    statsContainer: {
        padding: 16,
        backgroundColor: theme.colors.surface,
        margin: 16,
        borderRadius: 12,
        gap: 12,
    },
    codexCard: {
        backgroundColor: theme.colors.surface,
        borderRadius: 16,
        gap: 16,
        marginHorizontal: 16,
        marginTop: 16,
        padding: 20,
    },
    codexHeader: {
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'space-between',
    },
    codexAccountSelector: {
        flexDirection: 'row',
        gap: 8,
    },
    codexAccountChip: {
        backgroundColor: theme.colors.surface,
        borderRadius: 999,
        paddingHorizontal: 14,
        paddingVertical: 8,
    },
    codexAccountChipPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    codexAccountChipActive: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    codexAccountChipText: {
        color: theme.colors.textSecondary,
        fontSize: 13,
        fontWeight: '600',
    },
    codexAccountChipTextActive: {
        color: theme.colors.text,
    },
    codexTitle: {
        color: theme.colors.text,
        fontSize: 16,
        fontWeight: '600',
    },
    planBadge: {
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 999,
        maxWidth: '55%',
        paddingHorizontal: 10,
        paddingVertical: 4,
    },
    planBadgeText: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        fontWeight: '700',
        letterSpacing: 0.8,
    },
    quotaValue: {
        color: theme.colors.text,
        fontSize: 48,
        fontWeight: '700',
        lineHeight: 54,
    },
    quotaLabel: {
        color: theme.colors.textSecondary,
        fontSize: 15,
    },
    progressTrack: {
        backgroundColor: theme.colors.divider,
        borderRadius: 999,
        height: 8,
        overflow: 'hidden',
    },
    progressFill: {
        backgroundColor: theme.colors.accent,
        borderRadius: 999,
        height: '100%',
    },
    quotaDetails: {
        color: theme.colors.textSecondary,
        fontSize: 14,
        lineHeight: 20,
    },
    quotaReset: {
        color: theme.colors.text,
        fontSize: 14,
        fontWeight: '500',
        lineHeight: 20,
    },
    quotaScannedAt: {
        color: theme.colors.textSecondary,
        fontSize: 13,
    },
    heatmapSection: {
        gap: 12,
        marginHorizontal: 16,
        marginTop: 24,
    },
    heatmapHeader: {
        alignItems: 'baseline',
        flexDirection: 'row',
        justifyContent: 'space-between',
    },
    heatmapTitle: {
        color: theme.colors.text,
        fontSize: 17,
        fontWeight: '600',
    },
    heatmapLegend: {
        color: theme.colors.textSecondary,
        fontSize: 13,
    },
    heatmapGrid: {
        flexDirection: 'row',
        gap: 5,
    },
    heatmapCalendar: {
        paddingTop: 20,
        position: 'relative',
    },
    heatmapMonthLabel: {
        color: theme.colors.textSecondary,
        fontSize: 11,
        position: 'absolute',
        top: 0,
    },
    heatmapWeek: {
        gap: 5,
    },
    heatmapCell: {
        borderRadius: 4,
        height: CODEX_HEATMAP_CELL_SIZE,
        width: CODEX_HEATMAP_CELL_SIZE,
        ...Platform.select({
            web: {
                transitionDuration: '120ms',
                transitionProperty: 'background-color, opacity, transform',
                transitionTimingFunction: 'ease-out',
            } as any,
        }),
    },
    heatmapCellPlaceholder: {
        height: CODEX_HEATMAP_CELL_SIZE,
        width: CODEX_HEATMAP_CELL_SIZE,
    },
    heatmapCellInactive: {
        backgroundColor: theme.colors.surfaceHigh,
    },
    heatmapCellActive: {
        backgroundColor: theme.colors.accent,
    },
    heatmapCellSelected: {
        backgroundColor: theme.colors.surfaceSelected,
        borderColor: theme.colors.text,
        borderWidth: 1,
    },
    heatmapCellPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    heatmapCellHovered: {
        transform: [{ scale: 1.16 }],
        zIndex: 1,
    },
    heatmapSelection: {
        color: theme.colors.textSecondary,
        fontSize: 13,
    },
    statRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    statLabel: {
        fontSize: 16,
        color: theme.colors.text,
    },
    statValue: {
        fontSize: 20,
        fontWeight: '700',
        color: theme.colors.text,
    },
    chartSection: {
        marginTop: 16,
    },
    sectionTitle: {
        fontSize: 18,
        fontWeight: '600',
        color: theme.colors.text,
        marginHorizontal: 16,
        marginBottom: 8,
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 32,
    },
    errorContainer: {
        padding: 32,
        alignItems: 'center',
    },
    errorText: {
        fontSize: 14,
        color: theme.colors.status.error,
        textAlign: 'center',
    },
    emptyContainer: {
        alignItems: 'center',
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        gap: 10,
        marginHorizontal: 16,
        paddingVertical: 36,
    },
    emptyText: {
        fontSize: 15,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
    metricToggle: {
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 16,
        padding: 16,
    },
    metricButton: {
        paddingVertical: 6,
        paddingHorizontal: 16,
        borderRadius: 16,
        backgroundColor: theme.colors.divider,
    },
    metricButtonActive: {
        backgroundColor: theme.colors.accent,
    },
    metricText: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        fontWeight: '500',
    },
    metricTextActive: {
        color: '#FFFFFF',
    }
}));

export const UsagePanel: React.FC<{ sessionId?: string }> = ({ sessionId }) => {
    const { theme } = useUnistyles();
    const auth = useAuth();
    const machines = useAllMachines({ includeOffline: true });
    const codexAccounts = useCodexAccounts();
    const [selectedQuotaProfileId, setSelectedQuotaProfileId] = useState<string | null>(null);
    const [period, setPeriod] = useState<TimePeriod>('7days');
    const [chartMetric, setChartMetric] = useState<'tokens' | 'cost'>('tokens');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [usageData, setUsageData] = useState<UsageDataPoint[]>([]);
    const [totals, setTotals] = useState({
        totalTokens: 0,
        totalCost: 0,
        tokensByModel: {} as Record<string, number>,
        costByModel: {} as Record<string, number>
    });
    const [selectedCodexUsageDate, setSelectedCodexUsageDate] = useState<string | null>(null);
    const [hoveredCodexUsageDate, setHoveredCodexUsageDate] = useState<string | null>(null);
    const heatmapScrollRef = useRef<ScrollView>(null);
    const currentLanguage = getCurrentLanguage();
    const currentMachineId = storage((state) => {
        const currentSessionId = sessionId || state.currentViewingSessionId;
        return currentSessionId ? state.sessions[currentSessionId]?.metadata?.machineId || null : null;
    });
    const currentCodexProfileId = storage((state) => {
        const currentSessionId = sessionId || state.currentViewingSessionId;
        return currentSessionId ? state.sessions[currentSessionId]?.metadata?.codexAccountProfileId || null : null;
    });
    // A machine's local log scan is independent of the account selected for quota.
    // Never substitute another machine when the current session's machine is missing.
    const activityMachine = React.useMemo(() => {
        if (currentMachineId) return machines.find((machine) => machine.id === currentMachineId);
        const activeMachines = machines.filter((machine) => machine.active);
        if (activeMachines.length === 1) return activeMachines[0];
        return machines.length === 1 ? machines[0] : undefined;
    }, [currentMachineId, machines]);
    const activityMachineId = activityMachine?.id;
    const codexActivity = React.useMemo(
        () => getCodexUsageSnapshot(activityMachine?.daemonState),
        [activityMachine?.daemonState],
    );
    const preferredCodexProfileId = currentCodexProfileId
        || codexAccounts.bindings.find((binding) => binding.machineId === currentMachineId)?.profileId;
    const suggestedCodexProfileId = codexAccounts.profiles.some((profile) => profile.id === preferredCodexProfileId)
        ? preferredCodexProfileId
        : codexAccounts.profiles[0]?.id;
    const activeQuotaProfileId = selectedQuotaProfileId || suggestedCodexProfileId;
    const selectedCodexProfile = codexAccounts.profiles.find((profile) => profile.id === activeQuotaProfileId);
    const primaryCodexRateLimit = React.useMemo(
        () => getCodexAccountQuotaSummary(selectedCodexProfile),
        [selectedCodexProfile],
    );
    const codexQuotaObservedAt = selectedCodexProfile?.quota.observedAt
        ? Date.parse(selectedCodexProfile.quota.observedAt)
        : undefined;
    const codexHeatmapDays = React.useMemo(() => getCodexHeatmapDays(codexActivity), [codexActivity]);
    const codexHeatmapWeeks = React.useMemo(() => getCodexHeatmapWeeks(codexHeatmapDays), [codexHeatmapDays]);
    const codexHeatmapMonthLabels = React.useMemo(
        () => getCodexHeatmapMonthLabels(codexHeatmapWeeks, currentLanguage),
        [codexHeatmapWeeks, currentLanguage],
    );
    const maxCodexHeatmapTokens = React.useMemo(
        () => Math.max(...codexHeatmapDays.map((day) => day.totalTokens), 1),
        [codexHeatmapDays],
    );
    const selectedCodexUsageDay = codexHeatmapDays.find((day) => day.date === selectedCodexUsageDate)
        || [...codexHeatmapDays].reverse().find((day) => day.totalTokens > 0)
        || codexHeatmapDays.at(-1);
    const displayedCodexUsageDay = codexHeatmapDays.find((day) => day.date === hoveredCodexUsageDate)
        || selectedCodexUsageDay;
    const hasApiUsage = usageData.length > 0;

    useEffect(() => {
        if (selectedQuotaProfileId
            && !codexAccounts.profiles.some((profile) => profile.id === selectedQuotaProfileId)) {
            setSelectedQuotaProfileId(null);
        }
    }, [codexAccounts.profiles, selectedQuotaProfileId]);

    useEffect(() => {
        setSelectedCodexUsageDate(null);
        setHoveredCodexUsageDate(null);
        if (activityMachineId) {
            void apiSocket.machineRPC(
                activityMachineId,
                'refresh-codex-usage',
                {},
                { timeoutMs: CODEX_USAGE_REFRESH_RPC_TIMEOUT_MS },
            ).catch(() => {});
        }
    }, [activityMachineId]);
    
    useEffect(() => {
        let cancelled = false;

        const loadUsageData = async () => {
            const credentials = auth.credentials;
            if (!credentials) {
                setError('Not authenticated');
                setLoading(false);
                return;
            }

            setLoading(true);
            setError(null);

            try {
                const response = await getUsageForPeriod(credentials, period, sessionId);
                if (cancelled) {
                    return;
                }
                setUsageData(response.usage || []);
                setTotals(calculateTotals(response.usage || []));
            } catch (err) {
                if (cancelled) {
                    return;
                }
                console.error('Failed to load usage data:', err);
                if (err instanceof HappyError) {
                    setError(err.message);
                } else {
                    setError('Failed to load usage data');
                }
            } finally {
                if (!cancelled) {
                    setLoading(false);
                }
            }
        };

        void loadUsageData();
        return () => {
            cancelled = true;
        };
    }, [auth.credentials, period, sessionId]);
    
    const formatTokens = (tokens: number): string => {
        if (tokens >= 1000000) {
            return `${(tokens / 1000000).toFixed(2)}M`;
        } else if (tokens >= 1000) {
            return `${(tokens / 1000).toFixed(1)}K`;
        }
        return tokens.toLocaleString();
    };
    
    const formatCost = (cost: number): string => {
        return `$${cost.toFixed(4)}`;
    };
    
    const periodLabels: Record<TimePeriod, string> = {
        'today': t('usage.today'),
        '7days': t('usage.last7Days'),
        '30days': t('usage.last30Days')
    };
    
    // Get top models by usage
    const topModels = Object.entries(totals.tokensByModel)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5);
    
    const maxModelTokens = Math.max(...Object.values(totals.tokensByModel), 1);
    
    return (
        <ScrollView style={styles.container}>
            <View style={styles.codexCard} accessibilityLiveRegion="polite">
                <View style={styles.codexHeader}>
                    <Text style={styles.codexTitle}>{t('machine.codexUsage')}</Text>
                    {!!selectedCodexProfile && (
                        <View style={styles.planBadge}>
                            <Text style={styles.planBadgeText} numberOfLines={1}>
                                {selectedCodexProfile.displayName}
                            </Text>
                        </View>
                    )}
                </View>
                {codexAccounts.profiles.length > 0 && <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    <View style={styles.codexAccountSelector} accessibilityRole="tablist">
                        {codexAccounts.profiles.map((scope) => {
                            const active = scope.id === activeQuotaProfileId;
                            return (
                                <Pressable
                                    key={scope.id}
                                    testID={`codex-usage-scope-${scope.id}`}
                                    accessibilityRole="tab"
                                    aria-selected={active}
                                    onPress={() => setSelectedQuotaProfileId(scope.id)}
                                    style={({ pressed }) => [
                                        styles.codexAccountChip,
                                        active && styles.codexAccountChipActive,
                                        pressed && styles.codexAccountChipPressed,
                                    ]}
                                >
                                    <Text style={[styles.codexAccountChipText, active && styles.codexAccountChipTextActive]}>{scope.displayName}</Text>
                                </Pressable>
                            );
                        })}
                    </View>
                </ScrollView>}
                {primaryCodexRateLimit ? (
                    <>
                        <View>
                            <Text style={styles.quotaValue}>{`${primaryCodexRateLimit.remaining}%`}</Text>
                            <Text style={styles.quotaLabel}>{t('machine.codexUsageRemaining')}</Text>
                        </View>
                        <View style={styles.progressTrack}>
                            <View style={[styles.progressFill, { width: `${primaryCodexRateLimit.used}%` }]} />
                        </View>
                        <Text style={styles.quotaDetails}>
                            {t('machine.codexUsageRateLimitWindow', primaryCodexRateLimit)}
                        </Text>
                        <Text style={styles.quotaReset}>
                            {t('machine.codexUsageResetsAt', { time: primaryCodexRateLimit.resetAt })}
                        </Text>
                        {selectedCodexProfile?.quota.state === 'stale' && (
                            <Text style={styles.quotaDetails}>{t('codexAccounts.quotaStale')}</Text>
                        )}
                        {typeof codexQuotaObservedAt === 'number' && (
                            <Text style={styles.quotaScannedAt}>
                                {`${t('machine.codexUsageScannedAt')}: ${new Date(codexQuotaObservedAt).toLocaleString()}`}
                            </Text>
                        )}
                    </>
                ) : (
                    <Text style={styles.quotaDetails}>
                        {selectedCodexProfile
                            ? selectedCodexProfile.quota.state === 'reset'
                                ? `${t('codexAccounts.quotaUnknown')} · ${t('codexAccounts.quotaWaiting')}`
                                : t('codexAccounts.quotaUnknown')
                            : t('codexAccounts.quotaUnknown')}
                    </Text>
                )}
            </View>

            {codexHeatmapDays.length > 0 && (
                <View style={styles.heatmapSection}>
                    <View style={styles.heatmapHeader}>
                        <Text style={styles.heatmapTitle}>{t('machine.codexUsageHeatmap')}</Text>
                        <Text style={styles.heatmapLegend}>{t('machine.codexUsageHeatmapLegend')}</Text>
                    </View>
                    <ScrollView
                        ref={heatmapScrollRef}
                        testID="codex-usage-heatmap-scroll"
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        onContentSizeChange={() => heatmapScrollRef.current?.scrollToEnd({ animated: false })}
                    >
                        <View style={styles.heatmapCalendar}>
                            {codexHeatmapMonthLabels.map((month) => (
                                <Text
                                    key={month.key}
                                    testID={`codex-usage-month-${month.key}`}
                                    style={[
                                        styles.heatmapMonthLabel,
                                        { left: month.weekIndex * (CODEX_HEATMAP_CELL_SIZE + 5) },
                                    ]}
                                >
                                    {month.label}
                                </Text>
                            ))}
                            <View style={styles.heatmapGrid}>
                                {codexHeatmapWeeks.map((week, weekIndex) => (
                                    <View
                                        key={weekIndex}
                                        testID={`codex-usage-week-${weekIndex}`}
                                        style={styles.heatmapWeek}
                                    >
                                        {week.map((day, dayIndex) => {
                                            if (!day) {
                                                return <View key={`empty-${dayIndex}`} style={styles.heatmapCellPlaceholder} />;
                                            }
                                            const isActive = day.totalTokens > 0;
                                            const isSelected = day.date === selectedCodexUsageDay?.date;
                                            const isHovered = day.date === hoveredCodexUsageDate;
                                            const opacity = isActive
                                                ? getCodexHeatmapOpacity(day.totalTokens, maxCodexHeatmapTokens)
                                                : 1;
                                            return (
                                                <Pressable
                                                    key={day.date}
                                                    testID={`codex-usage-day-${day.date}`}
                                                    style={({ pressed }) => [
                                                        styles.heatmapCell,
                                                        isActive ? styles.heatmapCellActive : styles.heatmapCellInactive,
                                                        isActive && !isSelected && !isHovered && !pressed && { opacity },
                                                        (isSelected || isHovered) && styles.heatmapCellSelected,
                                                        isHovered && styles.heatmapCellHovered,
                                                        pressed && styles.heatmapCellPressed,
                                                    ]}
                                                    onPress={() => setSelectedCodexUsageDate(day.date)}
                                                    onHoverIn={Platform.OS === 'web'
                                                        ? () => setHoveredCodexUsageDate(day.date)
                                                        : undefined}
                                                    onHoverOut={Platform.OS === 'web'
                                                        ? () => setHoveredCodexUsageDate((current) => current === day.date ? null : current)
                                                        : undefined}
                                                    accessibilityRole="button"
                                                    accessibilityState={{ selected: isSelected }}
                                                    accessibilityLabel={t('machine.codexUsageHeatmapDay', {
                                                        date: day.date,
                                                        tokens: formatCodexActivityTokens(day.totalTokens, currentLanguage),
                                                        sessions: day.sessions,
                                                    })}
                                                />
                                            );
                                        })}
                                    </View>
                                ))}
                            </View>
                        </View>
                    </ScrollView>
                    {displayedCodexUsageDay && (
                        <Text style={styles.heatmapSelection}>
                            {t('machine.codexUsageHeatmapDay', {
                                date: displayedCodexUsageDay.date,
                                tokens: formatCodexActivityTokens(displayedCodexUsageDay.totalTokens, currentLanguage),
                                sessions: displayedCodexUsageDay.sessions,
                            })}
                        </Text>
                    )}
                </View>
            )}

            {loading && !codexActivity && (
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color={theme.colors.accent} />
                </View>
            )}

            {!!error && (
                <View style={styles.errorContainer}>
                    <Ionicons name="alert-circle-outline" size={48} color={theme.colors.status.error} />
                    <Text style={styles.errorText}>{error}</Text>
                </View>
            )}

            {hasApiUsage && (
                <>
                    <Text style={styles.sectionTitle}>{t('usage.apiUsage')}</Text>
                    <View
                        style={styles.periodSelector}
                        accessibilityRole="tablist"
                        accessibilityLabel={t('settings.usage')}
                    >
                        {(['today', '7days', '30days'] as TimePeriod[]).map((p) => (
                            <Pressable
                                key={p}
                                style={[styles.periodButton, period === p && styles.periodButtonActive]}
                                onPress={() => setPeriod(p)}
                                accessibilityRole="tab"
                                aria-selected={period === p}
                            >
                                <Text style={[styles.periodText, period === p && styles.periodTextActive]}>
                                    {periodLabels[p]}
                                </Text>
                            </Pressable>
                        ))}
                    </View>
                    <View style={styles.statsContainer}>
                        <View style={styles.statRow}>
                            <Text style={styles.statLabel}>{t('usage.totalTokens')}</Text>
                            <Text style={styles.statValue}>{formatTokens(totals.totalTokens)}</Text>
                        </View>
                        <View style={styles.statRow}>
                            <Text style={styles.statLabel}>{t('usage.totalCost')}</Text>
                            <Text style={styles.statValue}>{formatCost(totals.totalCost)}</Text>
                        </View>
                    </View>
                </>
            )}
            
            {/* Usage Chart */}
            {hasApiUsage && (
                <View style={styles.chartSection}>
                    <Text style={styles.sectionTitle}>{t('usage.usageOverTime')}</Text>
                    
                    {/* Metric Toggle */}
                    <View
                        style={styles.metricToggle}
                        accessibilityRole="tablist"
                        accessibilityLabel={t('usage.usageOverTime')}
                    >
                        <Pressable
                            style={[styles.metricButton, chartMetric === 'tokens' && styles.metricButtonActive]}
                            onPress={() => setChartMetric('tokens')}
                            accessibilityRole="tab"
                            aria-selected={chartMetric === 'tokens'}
                        >
                            <Text style={[styles.metricText, chartMetric === 'tokens' && styles.metricTextActive]}>
                                {t('usage.tokens')}
                            </Text>
                        </Pressable>
                        <Pressable
                            style={[styles.metricButton, chartMetric === 'cost' && styles.metricButtonActive]}
                            onPress={() => setChartMetric('cost')}
                            accessibilityRole="tab"
                            aria-selected={chartMetric === 'cost'}
                        >
                            <Text style={[styles.metricText, chartMetric === 'cost' && styles.metricTextActive]}>
                                {t('usage.cost')}
                            </Text>
                        </Pressable>
                    </View>
                    
                    <UsageChart 
                        data={usageData}
                        metric={chartMetric}
                        height={180}
                    />
                </View>
            )}
            
            {/* Usage by Model */}
            {hasApiUsage && topModels.length > 0 && (
                <ItemGroup title={t('usage.byModel')}>
                    <View style={{ padding: 16 }}>
                        {topModels.map(([model, tokens]) => (
                            <UsageBar
                                key={model}
                                label={model}
                                value={tokens}
                                maxValue={maxModelTokens}
                                color={theme.colors.accent}
                            />
                        ))}
                    </View>
                </ItemGroup>
            )}
        </ScrollView>
    );
};
