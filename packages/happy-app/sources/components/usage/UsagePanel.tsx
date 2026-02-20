import React, { useState, useEffect } from 'react';
import { View, ActivityIndicator, ScrollView, Pressable } from 'react-native';
import { Text } from '@/components/StyledText';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useAuth } from '@/auth/AuthContext';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { UsageChart } from './UsageChart';
import { UsageBar } from './UsageBar';
import { getUsageForPeriod, calculateTotals, UsageDataPoint } from '@/sync/apiUsage';
import { Ionicons } from '@expo/vector-icons';
import { HappyError } from '@/utils/errors';
import { t } from '@/text';

type TimePeriod = 'today' | '7days' | '30days';

type Provider = 'all' | 'claude' | 'codex' | 'gemini';

const PROVIDER_KEYS: Record<Provider, string[] | undefined> = {
    all: undefined,
    claude: ['claude-session'],
    codex: ['codex-session'],
    gemini: ['gemini-session'],
};

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
    },
    periodSelector: {
        flexDirection: 'row',
        paddingHorizontal: 16,
        paddingTop: 16,
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
        backgroundColor: '#007AFF',
    },
    periodText: {
        fontSize: 14,
        color: theme.colors.text,
        fontWeight: '500',
    },
    periodTextActive: {
        color: '#FFFFFF',
    },
    providerSelector: {
        flexDirection: 'row',
        paddingHorizontal: 16,
        paddingTop: 8,
        gap: 6,
    },
    providerButton: {
        paddingVertical: 4,
        paddingHorizontal: 10,
        borderRadius: 12,
        backgroundColor: 'transparent',
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    providerButtonActive: {
        backgroundColor: theme.colors.text,
        borderColor: theme.colors.text,
    },
    providerText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontWeight: '500',
    },
    providerTextActive: {
        color: theme.colors.groupped.background,
    },
    statsContainer: {
        padding: 16,
        backgroundColor: theme.colors.surface,
        margin: 16,
        borderRadius: 12,
        gap: 12,
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
}));

export const UsagePanel: React.FC<{ sessionId?: string }> = ({ sessionId }) => {
    const { theme } = useUnistyles();
    const auth = useAuth();
    const [period, setPeriod] = useState<TimePeriod>('7days');
    const [provider, setProvider] = useState<Provider>('all');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [usageData, setUsageData] = useState<UsageDataPoint[]>([]);
    const [totals, setTotals] = useState({
        totalTokens: 0,
        tokensByType: {} as Record<string, number>,
    });

    useEffect(() => {
        loadUsageData();
    }, [period, sessionId, provider]);

    const loadUsageData = async () => {
        if (!auth.credentials) {
            setError('Not authenticated');
            return;
        }

        if (provider === 'gemini') {
            return;
        }

        setLoading(true);
        setError(null);

        try {
            const keys = PROVIDER_KEYS[provider];
            const response = await getUsageForPeriod(auth.credentials, period, sessionId, keys);
            setUsageData(response.usage || []);
            setTotals(calculateTotals(response.usage || []));
        } catch (err) {
            console.error('Failed to load usage data:', err);
            if (err instanceof HappyError) {
                setError(err.message);
            } else {
                setError('Failed to load usage data');
            }
        } finally {
            setLoading(false);
        }
    };

    const formatTokens = (tokens: number): string => {
        if (tokens >= 1000000) {
            return `${(tokens / 1000000).toFixed(2)}M`;
        } else if (tokens >= 1000) {
            return `${(tokens / 1000).toFixed(1)}K`;
        }
        return tokens.toLocaleString();
    };

    const periodLabels: Record<TimePeriod, string> = {
        'today': t('usage.today'),
        '7days': t('usage.last7Days'),
        '30days': t('usage.last30Days')
    };

    const TOKEN_TYPE_LABELS: Record<string, string> = {
        input: t('usage.tokenInput'),
        output: t('usage.tokenOutput'),
        cache_read: t('usage.tokenCacheRead'),
        cache_creation: t('usage.tokenCacheCreation'),
        reasoning: t('usage.tokenReasoning'),
    };

    // Get top token types by usage (e.g. input, output, cache_read, cache_creation)
    const topTypes = Object.entries(totals.tokensByType)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5);

    const maxTypeTokens = Math.max(...Object.values(totals.tokensByType), 1);

    return (
        <ScrollView style={styles.container}>
            {/* Period Selector - always visible */}
            <View style={styles.periodSelector}>
                {(['today', '7days', '30days'] as TimePeriod[]).map((p) => (
                    <Pressable
                        key={p}
                        style={[styles.periodButton, period === p && styles.periodButtonActive]}
                        onPress={() => setPeriod(p)}
                    >
                        <Text style={[styles.periodText, period === p && styles.periodTextActive]}>
                            {periodLabels[p]}
                        </Text>
                    </Pressable>
                ))}
            </View>

            {/* Provider Selector */}
            <View style={styles.providerSelector}>
                {(['all', 'claude', 'codex', 'gemini'] as Provider[]).map((p) => (
                    <Pressable
                        key={p}
                        style={[styles.providerButton, provider === p && styles.providerButtonActive]}
                        onPress={() => setProvider(p)}
                    >
                        <Text style={[styles.providerText, provider === p && styles.providerTextActive]}>
                            {t(`usage.${p === 'all' ? 'allProviders' : p === 'claude' ? 'claudeCode' : p}`)}
                        </Text>
                    </Pressable>
                ))}
            </View>

            {provider === 'gemini' ? (
                <View style={styles.loadingContainer}>
                    <Ionicons name="analytics-outline" size={48} color={theme.colors.textSecondary} />
                    <Text style={[styles.errorText, { color: theme.colors.textSecondary, marginTop: 12 }]}>
                        {t('usage.providerNoData')}
                    </Text>
                </View>
            ) : loading ? (
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color="#007AFF" />
                </View>
            ) : error ? (
                <View style={styles.errorContainer}>
                    <Ionicons name="alert-circle-outline" size={48} color={theme.colors.status.error} />
                    <Text style={styles.errorText}>{error}</Text>
                </View>
            ) : (<>

            {/* Summary Stats */}
            <View style={styles.statsContainer}>
                <View style={styles.statRow}>
                    <Text style={styles.statLabel}>{t('usage.totalTokens')}</Text>
                    <Text style={styles.statValue}>{formatTokens(totals.totalTokens)}</Text>
                </View>
            </View>

            {/* Usage Chart */}
            {usageData.length > 0 && (
                <View style={styles.chartSection}>
                    <Text style={styles.sectionTitle}>{t('usage.usageOverTime')}</Text>

                    <UsageChart
                        data={usageData}
                        height={180}
                    />
                </View>
            )}

            {/* Token Breakdown */}
            {topTypes.length > 0 && (
                <ItemGroup title={t('usage.tokenBreakdown')}>
                    <View style={{ padding: 16 }}>
                        {topTypes.map(([type, tokens]) => (
                            <UsageBar
                                key={type}
                                label={TOKEN_TYPE_LABELS[type] || type}
                                value={tokens}
                                maxValue={maxTypeTokens}
                                color="#007AFF"
                            />
                        ))}
                    </View>
                </ItemGroup>
            )}
            </>)}
        </ScrollView>
    );
};
