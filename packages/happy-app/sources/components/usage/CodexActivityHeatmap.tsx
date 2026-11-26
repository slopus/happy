import * as React from 'react';
import { AccessibilityInfo, Animated, Pressable, ScrollView, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { t } from '@/text';
import { multiplyColorOpacity } from '@/utils/colorOpacity';
import {
    buildActivityCalendar, formatActivityTokens, getActivityLevel, type ActivityDay,
} from './codexActivityCalendar';
import type { CodexActivityHeatmapProps } from './CodexActivityHeatmap.types';
import { useActivityDisclosure } from './useActivityDisclosure';
import {
    ACTIVITY_CELL_SIZE as CELL_SIZE, ACTIVITY_GAP as CELL_GAP, ACTIVITY_LEVEL_ALPHA,
    filterActivityMonths, getActivityMetrics,
} from './activityPresentation';

export type { CodexActivityHeatmapProps } from './CodexActivityHeatmap.types';

const COLUMN_WIDTH = CELL_SIZE + CELL_GAP;
const MONTH_ROW_HEIGHT = 24;
const MIN_SUMMARY_HEIGHT = 76;
const INITIAL_REGION_HEIGHT = MONTH_ROW_HEIGHT + CELL_SIZE * 7 + CELL_GAP * 6 + 28 + MIN_SUMMARY_HEIGHT;
const METRIC_ICONS = {
    input: 'document-text-outline', cache: 'layers-outline', output: 'chatbox-ellipses-outline',
} as const;

/** Keep the initial async reading from overwriting a newer runtime preference. */
function useNativeActivityReducedMotion() {
    const [reduced, setReduced] = React.useState<boolean | null>(null);
    React.useEffect(() => {
        let mounted = true;
        let receivedEvent = false;
        const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', enabled => {
            receivedEvent = true;
            if (mounted) setReduced(enabled);
        });
        void AccessibilityInfo.isReduceMotionEnabled().then(enabled => {
            if (mounted && !receivedEvent) setReduced(enabled);
        }).catch(() => {
            if (mounted && !receivedEvent) setReduced(true);
        });
        return () => { mounted = false; subscription.remove(); };
    }, []);
    return reduced;
}

/**
 * Native adapts the reference's overlay/disclosure with a single native-driven
 * progress value. Its small chart points have separate 44dp date controls.
 */
export function CodexActivityHeatmap(props: CodexActivityHeatmapProps) {
    const { snapshot, language } = props;
    const { theme } = useUnistyles();
    const calendar = React.useMemo(() => buildActivityCalendar(snapshot), [snapshot]);
    const { open: expanded, toggle } = useActivityDisclosure(props);
    const reducedMotion = useNativeActivityReducedMotion();
    const [selectedDate, setSelectedDate] = React.useState<string | null>(null);
    const [focusedDate, setFocusedDate] = React.useState<string | null>(null);
    const [summaryFocused, setSummaryFocused] = React.useState(false);
    const [focusedNavigation, setFocusedNavigation] = React.useState<'previous' | 'next' | null>(null);
    const [regionHeight, setRegionHeight] = React.useState(INITIAL_REGION_HEIGHT);
    const [summaryHeight, setSummaryHeight] = React.useState(MIN_SUMMARY_HEIGHT);
    const [panelProgress] = React.useState(() => new Animated.Value(expanded ? 1 : 0));
    const [entryProgress] = React.useState(() => new Animated.Value(1));
    const entered = React.useRef(false);
    const scrollRef = React.useRef<ScrollView>(null);
    const detailsScrollRef = React.useRef<ScrollView>(null);
    const initialScrollDone = React.useRef(false);
    const viewportWidth = React.useRef(0);
    const contentWidth = React.useRef(0);
    const selectedDay = calendar.days.find(day => day.date === selectedDate)
        ?? [...calendar.days].reverse().find(day => day.totalTokens > 0)
        ?? calendar.days.at(-1);
    const selectedIndex = selectedDay ? calendar.days.findIndex(day => day.date === selectedDay.date) : -1;
    const monthFormatter = React.useMemo(
        () => new Intl.DateTimeFormat(language, { month: 'short', timeZone: 'UTC' }), [language],
    );
    const weekdayFormatter = React.useMemo(
        () => new Intl.DateTimeFormat(language, { weekday: 'narrow', timeZone: 'UTC' }), [language],
    );
    const metricLabels = {
        input: t('codexActivity.uncachedInput'), cache: t('codexActivity.cacheRead'), output: t('codexActivity.output'),
    };
    const shortMetricLabels = {
        input: t('codexActivity.metricInputShort'), cache: t('codexActivity.metricCacheShort'), output: t('codexActivity.metricOutputShort'),
    };
    const dayDescription = (day: ActivityDay) => t('machine.codexUsageHeatmapDay', {
        date: day.date, tokens: formatActivityTokens(day.totalTokens, language, true), sessions: day.sessions,
    });
    const colorForLevel = (level: number) => level === 0
        ? theme.colors.surfaceHigh
        : multiplyColorOpacity(theme.colors.accent, ACTIVITY_LEVEL_ALPHA[level as 1 | 2 | 3 | 4]);
    const scrollToLatestOnce = () => {
        if (initialScrollDone.current || viewportWidth.current <= 0 || contentWidth.current <= 0) return;
        initialScrollDone.current = true;
        if (contentWidth.current > viewportWidth.current) scrollRef.current?.scrollToEnd({ animated: false });
    };

    React.useEffect(() => {
        panelProgress.stopAnimation();
        if (reducedMotion !== false || !calendar.days.length) {
            panelProgress.setValue(expanded ? 1 : 0);
            return;
        }
        const animation = Animated.spring(panelProgress, {
            toValue: expanded ? 1 : 0, damping: 26, stiffness: 260, mass: 1, useNativeDriver: true,
        });
        animation.start();
        return () => animation.stop();
    }, [calendar.days.length, expanded, panelProgress, reducedMotion]);

    React.useEffect(() => {
        entryProgress.stopAnimation();
        if (reducedMotion !== false || entered.current || !calendar.days.length) {
            entryProgress.setValue(1);
            return;
        }
        entered.current = true;
        entryProgress.setValue(0);
        const animation = Animated.timing(entryProgress, { toValue: 1, duration: 220, useNativeDriver: true });
        animation.start();
        return () => animation.stop();
    }, [calendar.days.length, entryProgress, reducedMotion]);

    React.useEffect(() => {
        if (!calendar.days.length) {
            // A missing snapshot removes the physical ScrollView. Its replacement
            // gets one initial positioning, without resetting ordinary updates.
            initialScrollDone.current = false;
            viewportWidth.current = 0;
            contentWidth.current = 0;
        }
    }, [calendar.days.length]);

    React.useEffect(() => {
        if (selectedDay) detailsScrollRef.current?.scrollTo({ y: 0, animated: false });
    }, [selectedDay?.date]);

    if (!snapshot || !selectedDay || !calendar.from || !calendar.to) return null;
    const metrics = getActivityMetrics(selectedDay);
    const warnings = (snapshot as typeof snapshot & { warnings?: unknown }).warnings;
    const moveDate = (amount: number) => {
        const next = calendar.days[Math.max(0, Math.min(calendar.days.length - 1, selectedIndex + amount))];
        if (next) setSelectedDate(next.date);
    };
    const panelTranslateY = panelProgress.interpolate({
        inputRange: [0, 1], outputRange: [Math.max(0, regionHeight - summaryHeight), 0], extrapolate: 'clamp',
    });

    return (
        <View style={styles.card} testID="codex-activity-card">
            <View style={styles.header}>
                <Text style={styles.title}>{t('machine.codexUsageHeatmap')}</Text>
                <View style={styles.legend} accessible={false}>
                    <Text style={styles.caption}>{t('machine.codexUsageHeatmapLegend')}</Text>
                    {[0, 1, 2, 3, 4].map(level => (
                        <View key={level} style={[styles.legendCell, { backgroundColor: colorForLevel(level) }]} />
                    ))}
                </View>
            </View>
            <Text style={styles.caption} testID="codex-activity-scope">{t('codexActivity.scope')}</Text>
            <View style={styles.rangeRow}>
                <Text style={styles.caption} testID="codex-activity-range">{`${calendar.from} – ${calendar.to}`}</Text>
                <Text style={styles.caption} accessibilityLabel={`${t('codexActivity.processed')}: ${formatActivityTokens(calendar.total, language, true)}`}>
                    {`${t('codexActivity.processed')}: ${formatActivityTokens(calendar.total, language)}`}
                </Text>
            </View>
            <View
                style={styles.interactionRegion}
                testID="codex-activity-native-region"
                onLayout={event => {
                    const height = event.nativeEvent.layout.height;
                    if (height > 0) setRegionHeight(current => Math.abs(current - height) > 0.5 ? height : current);
                }}
            >
                <Animated.View
                    pointerEvents={expanded ? 'none' : 'auto'}
                    accessibilityElementsHidden={expanded}
                    importantForAccessibility={expanded ? 'no-hide-descendants' : 'auto'}
                    style={{ opacity: panelProgress.interpolate({ inputRange: [0, 1], outputRange: [1, 0.12] }) }}
                >
                    <Animated.View style={{
                        opacity: entryProgress.interpolate({ inputRange: [0, 1], outputRange: [0.65, 1] }),
                        transform: [{ translateY: entryProgress.interpolate({ inputRange: [0, 1], outputRange: [4, 0] }) }],
                    }}>
                        <View style={styles.calendarRow}>
                            <View style={styles.weekdays} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                                {Array.from({ length: 7 }, (_, weekday) => (
                                    <Text key={weekday} style={styles.weekday}>
                                        {weekdayFormatter.format(new Date(Date.UTC(2026, 0, 4 + weekday)))}
                                    </Text>
                                ))}
                            </View>
                            <ScrollView
                                ref={scrollRef} horizontal nestedScrollEnabled showsHorizontalScrollIndicator
                                style={styles.scroll} contentContainerStyle={styles.scrollContent}
                                testID="codex-usage-heatmap-scroll"
                                onLayout={event => { viewportWidth.current = event.nativeEvent.layout.width; scrollToLatestOnce(); }}
                                onContentSizeChange={width => { contentWidth.current = width; scrollToLatestOnce(); }}
                            >
                                <View style={[styles.calendar, { width: calendar.weeks.length * COLUMN_WIDTH - CELL_GAP }]} testID="codex-usage-heatmap">
                                    {filterActivityMonths(calendar.months).map(month => (
                                        <Text key={month.key} style={[styles.month, { left: month.weekIndex * COLUMN_WIDTH }]} testID={`codex-usage-month-${month.key}`}>
                                            {monthFormatter.format(new Date(`${month.date}T00:00:00.000Z`))}
                                        </Text>
                                    ))}
                                    <View style={styles.grid} testID="codex-usage-heatmap-grid">
                                        {calendar.weeks.map((week, weekIndex) => (
                                            <View key={weekIndex} style={styles.week} testID={`codex-usage-week-${weekIndex}`}>
                                                {week.map((day, dayIndex) => {
                                                    if (!day) return <View key={`pad-${dayIndex}`} style={styles.cellFrame} />;
                                                    const selected = day.date === selectedDay.date;
                                                    const focused = day.date === focusedDate;
                                                    return (
                                                        <View key={day.date} style={styles.cellFrame}>
                                                            <Pressable
                                                                accessibilityRole="button" accessibilityLabel={dayDescription(day)}
                                                                accessibilityState={{ selected }}
                                                                onPress={() => setSelectedDate(day.date)}
                                                                onFocus={() => setFocusedDate(day.date)}
                                                                onBlur={() => setFocusedDate(current => current === day.date ? null : current)}
                                                                style={[styles.cell, { backgroundColor: colorForLevel(getActivityLevel(day.totalTokens, calendar.max)) }]}
                                                                testID={`codex-usage-day-${day.date}`}
                                                            />
                                                            {(selected || focused) && <View pointerEvents="none" style={[styles.selectionRing, focused && styles.focusRing]} />}
                                                        </View>
                                                    );
                                                })}
                                            </View>
                                        ))}
                                    </View>
                                </View>
                            </ScrollView>
                        </View>
                    </Animated.View>
                </Animated.View>
                <View style={{ height: summaryHeight + 16 }} />
                <Animated.View
                    pointerEvents="box-none"
                    style={[styles.panel, { transform: [{ translateY: panelTranslateY }] }]}
                    testID="codex-usage-detail"
                >
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`${dayDescription(selectedDay)}. ${t(expanded ? 'codexActivity.hideDetails' : 'codexActivity.showDetails')}`}
                        accessibilityState={{ expanded }}
                        onPress={toggle}
                        onFocus={() => setSummaryFocused(true)} onBlur={() => setSummaryFocused(false)}
                        onLayout={event => {
                            const height = event.nativeEvent.layout.height;
                            if (height > 0) setSummaryHeight(current => Math.abs(current - height) > 0.5 ? height : current);
                        }}
                        style={({ pressed }) => [styles.summary, pressed && styles.summaryPressed, summaryFocused && styles.summaryFocused]}
                        testID="codex-activity-detail-toggle"
                    >
                        <View style={styles.summaryText}>
                            <Text style={styles.selectedDate}>{selectedDay.date}</Text>
                            <Text style={styles.caption}>{`${formatActivityTokens(selectedDay.totalTokens, language)} token · ${selectedDay.sessions} ${t('machine.codexUsageSessions')}`}</Text>
                        </View>
                        <Animated.View
                            accessibilityElementsHidden importantForAccessibility="no-hide-descendants" pointerEvents="none"
                            style={[styles.metricStack, {
                                opacity: panelProgress.interpolate({ inputRange: [0, 0.6, 1], outputRange: [1, 0, 0] }),
                                transform: [{ translateY: panelProgress.interpolate({ inputRange: [0, 1], outputRange: [0, -10] }) }],
                            }]}
                        >
                            {metrics.map((metric, index) => (
                                <View key={metric.key} style={[styles.stackBadge, { left: index * 17, zIndex: 3 - index }]}>
                                    <Ionicons name={METRIC_ICONS[metric.key]} size={14} color={theme.colors.textSecondary} />
                                </View>
                            ))}
                        </Animated.View>
                        <Text style={styles.action}>{t(expanded ? 'codexActivity.hideDetails' : 'codexActivity.showDetails')}</Text>
                    </Pressable>
                    <View
                        style={styles.panelBody} pointerEvents={expanded ? 'auto' : 'none'}
                        accessibilityElementsHidden={!expanded}
                        importantForAccessibility={expanded ? 'auto' : 'no-hide-descendants'}
                        testID="codex-activity-breakdown"
                    >
                        <View style={styles.navigation}>
                            {([
                                { key: 'previous' as const, disabled: selectedIndex <= 0, amount: -1, label: t('codexActivity.previousDay') },
                                { key: 'next' as const, disabled: selectedIndex >= calendar.days.length - 1, amount: 1, label: t('codexActivity.nextDay') },
                            ]).map(action => (
                                <Pressable
                                    key={action.key} accessibilityRole="button" accessibilityLabel={action.label}
                                    accessibilityState={{ disabled: action.disabled }} disabled={action.disabled}
                                    onPress={() => moveDate(action.amount)}
                                    onFocus={() => setFocusedNavigation(action.key)} onBlur={() => setFocusedNavigation(null)}
                                    style={({ pressed }) => [styles.navigationButton, pressed && styles.summaryPressed, focusedNavigation === action.key && styles.navigationFocused, action.disabled && styles.disabled]}
                                    testID={`codex-activity-${action.key}-day`}
                                >
                                    <Text style={styles.navigationLabel}>{action.label}</Text>
                                </Pressable>
                            ))}
                        </View>
                        <ScrollView
                            ref={detailsScrollRef} nestedScrollEnabled showsVerticalScrollIndicator
                            style={styles.detailsScroll} contentContainerStyle={styles.breakdown}
                            accessibilityLabel={t('codexActivity.detailsLabel')} testID="codex-activity-native-details-scroll"
                        >
                            {metrics.map((metric, index) => (
                                <Animated.View
                                    key={metric.key}
                                    style={[styles.metric, {
                                        opacity: panelProgress.interpolate({ inputRange: [0, 0.2 + index * 0.1, 1], outputRange: [0, 0, 1] }),
                                        transform: [{ translateY: panelProgress.interpolate({ inputRange: [0, 1], outputRange: [10 + index * 3, 0] }) }],
                                    }]}
                                    accessible
                                    accessibilityLabel={`${metricLabels[metric.key]}: ${formatActivityTokens(metric.value, language, true)}`}
                                >
                                    <View style={styles.metricBadge}>
                                        <Ionicons name={METRIC_ICONS[metric.key]} size={17} color={theme.colors.textSecondary} />
                                    </View>
                                    <View style={styles.metricLabel}>
                                        <Text style={styles.caption}>{metricLabels[metric.key]}</Text>
                                        <Text style={styles.metricShort}>{shortMetricLabels[metric.key]}</Text>
                                    </View>
                                    <Text
                                        accessibilityLabel={`${metricLabels[metric.key]}: ${formatActivityTokens(metric.value, language, true)}`}
                                        selectable style={styles.metricValue}
                                        testID={`codex-activity-metric-${metric.key === 'input' ? 'uncached-input' : metric.key === 'cache' ? 'cache-read' : 'output'}`}
                                    >
                                        {formatActivityTokens(metric.value, language)}
                                    </Text>
                                </Animated.View>
                            ))}
                            <Text
                                style={styles.note}
                                accessibilityLabel={`${t('codexActivity.total')}: ${formatActivityTokens(selectedDay.totalTokens, language, true)}`}
                                testID="codex-activity-metric-total"
                            >{`${t('codexActivity.total')}: ${formatActivityTokens(selectedDay.totalTokens, language, true)} token`}</Text>
                            <Text style={styles.note}>{t('codexActivity.cacheNote')}</Text>
                        </ScrollView>
                    </View>
                </Animated.View>
            </View>
            {calendar.total === 0 && <Text style={styles.caption}>{t('codexActivity.noActivity')}</Text>}
            {Array.isArray(warnings) && warnings.length > 0 && <Text style={styles.caption}>{t('codexActivity.incomplete')}</Text>}
            <Text style={styles.caption}>
                {`${t('machine.codexUsageScannedAt')}: ${new Date(snapshot.scannedAt).toLocaleString(language, { timeZone: snapshot.timeZone })}${snapshot.timeZone ? ` (${snapshot.timeZone})` : ''}`}
            </Text>
        </View>
    );
}

const styles = StyleSheet.create(theme => ({
    card: { marginHorizontal: 12, marginTop: 20, marginBottom: 24, padding: 16, gap: 10, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, backgroundColor: theme.colors.surface },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 },
    title: { color: theme.colors.text, fontSize: 17, fontWeight: '600' },
    caption: { color: theme.colors.textSecondary, fontSize: 12, lineHeight: 18 },
    legend: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    legendCell: { height: 9, width: 9, borderRadius: 2 },
    rangeRow: { flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 4 },
    interactionRegion: { position: 'relative', overflow: 'hidden', borderRadius: 12 },
    calendarRow: { flexDirection: 'row', gap: 8 },
    weekdays: { paddingTop: MONTH_ROW_HEIGHT + 2, gap: CELL_GAP, width: 18 },
    weekday: { fontSize: 9, lineHeight: CELL_SIZE, height: CELL_SIZE, color: theme.colors.textSecondary, textAlign: 'center' },
    scroll: { flex: 1, flexGrow: 1 },
    scrollContent: { padding: 2, paddingBottom: 10 },
    calendar: { position: 'relative', paddingTop: MONTH_ROW_HEIGHT },
    month: { position: 'absolute', top: 0, fontSize: 10, lineHeight: 14, color: theme.colors.textSecondary },
    grid: { flexDirection: 'row', gap: CELL_GAP },
    week: { gap: CELL_GAP },
    cellFrame: { width: CELL_SIZE, height: CELL_SIZE, position: 'relative' },
    cell: { width: CELL_SIZE, height: CELL_SIZE, borderRadius: 3 },
    selectionRing: { position: 'absolute', top: -2, bottom: -2, left: -2, right: -2, borderWidth: 1, borderColor: theme.colors.text, borderRadius: 5 },
    focusRing: { borderWidth: 2, borderColor: theme.colors.textLink },
    panel: { ...StyleSheet.absoluteFillObject, borderRadius: 12, backgroundColor: theme.colors.surfaceHigh, overflow: 'hidden' },
    summary: { minHeight: MIN_SUMMARY_HEIGHT, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 8 },
    summaryPressed: { backgroundColor: theme.colors.surfacePressed },
    summaryFocused: { borderWidth: 2, borderColor: theme.colors.textLink },
    summaryText: { flex: 1, flexShrink: 1, gap: 2 },
    selectedDate: { color: theme.colors.text, fontSize: 13, fontWeight: '600' },
    action: { color: theme.colors.text, fontSize: 11, flexShrink: 1, maxWidth: 70 },
    metricStack: { position: 'relative', width: 62, height: 28 },
    stackBadge: { position: 'absolute', width: 28, height: 28, borderRadius: 14, borderWidth: 1, borderColor: theme.colors.divider, backgroundColor: theme.colors.surface, alignItems: 'center', justifyContent: 'center' },
    panelBody: { flex: 1, minHeight: 0 },
    navigation: { flexDirection: 'row', paddingHorizontal: 12, gap: 8, paddingBottom: 6 },
    navigationButton: { flex: 1, minHeight: 44, borderRadius: 8, backgroundColor: theme.colors.surface, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center' },
    navigationFocused: { borderWidth: 2, borderColor: theme.colors.textLink },
    navigationLabel: { color: theme.colors.text, fontSize: 12, fontWeight: '500' },
    disabled: { opacity: 0.45 },
    detailsScroll: { flex: 1, minHeight: 0 },
    breakdown: { paddingHorizontal: 12, paddingBottom: 12, gap: 10 },
    metric: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10 },
    metricBadge: { width: 28, height: 28, borderRadius: 14, backgroundColor: theme.colors.surface, alignItems: 'center', justifyContent: 'center' },
    metricLabel: { flex: 1, flexShrink: 1, gap: 2 },
    metricShort: { color: theme.colors.textSecondary, fontSize: 10 },
    metricValue: { color: theme.colors.text, fontSize: 16, fontWeight: '600', flexShrink: 1 },
    note: { color: theme.colors.textSecondary, fontSize: 11, lineHeight: 17 },
}));
