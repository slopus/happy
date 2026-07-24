import * as React from 'react';
import { Platform, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import Svg, { Circle } from 'react-native-svg';
import { hapticsLight } from './haptics';
import { t } from '@/text';
import type { EffortLevel, ModelMode, ModeOption } from './modelModeOptions';
import { AnimatedPopup, LocalBlurHalo } from './AnimatedOverlay';
import { MobileGlassSurface } from './MobileGlass';
import {
    clampContextSize,
    formatUsageLimitAge,
    getContextUsageLevel,
    getContextUsagePercentage,
    getUsageLimitChips,
    getUsageLimitDisplayPercentage,
    getUsageLimitRows,
    type UsageLimitsLike,
    type UsageLimitStatus,
} from '@/utils/sessionStatusBar';
import { useSetting } from '@/sync/storage';

type StatusIconName = React.ComponentProps<typeof Ionicons>['name'];

type SessionStatusBarProps = {
    gitBranch: string | null | undefined;
    modelLabel: string | null;
    modelMode?: ModelMode | null;
    availableModels?: ModelMode[];
    onModelModeChange?: (mode: ModelMode) => void;
    effortLabel: string | null;
    effortLevel?: EffortLevel | null;
    availableEffortLevels?: EffortLevel[];
    onEffortLevelChange?: (level: EffortLevel) => void;
    contextSize: number | null | undefined;
    contextWindow?: number | null | undefined;
    usageLimits?: UsageLimitsLike;
};

type OpenMenu = 'model' | 'effort' | 'limits' | null;

// Below this window width the two limit chips collapse into one (the window
// closest to its limit). Width-based rather than device-based: a narrow
// desktop window needs the collapse just as much as a phone does.
const LIMIT_CHIP_COLLAPSE_WIDTH = 480;

export function SessionStatusBar(props: SessionStatusBarProps) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const [openMenu, setOpenMenu] = React.useState<OpenMenu>(null);
    const availableModels = props.availableModels ?? [];
    const availableEffortLevels = props.availableEffortLevels ?? [];
    const canSelectModel = availableModels.length > 0 && !!props.onModelModeChange;
    const canSelectEffort = availableEffortLevels.length > 0 && !!props.onEffortLevelChange;
    // Until the session reports its window there is no honest denominator, so
    // the circle is omitted rather than drawn against a guess — a percentage
    // that later corrects itself upward reads as the context refilling.
    const contextMaxValue = typeof props.contextWindow === 'number' && Number.isFinite(props.contextWindow) && props.contextWindow > 0
        ? Math.trunc(props.contextWindow)
        : null;
    const contextValue = contextMaxValue === null ? 0 : clampContextSize(props.contextSize, contextMaxValue);
    const contextPercentage = contextMaxValue === null ? 0 : getContextUsagePercentage(props.contextSize, contextMaxValue);
    const contextLevel = contextMaxValue === null ? 'normal' : getContextUsageLevel(props.contextSize, contextMaxValue);
    const contextColor = contextLevel === 'critical'
        ? theme.colors.warningCritical
        : contextLevel === 'warning'
            ? theme.colors.warning
            : theme.colors.status.connecting;
    const { width: windowWidth } = useWindowDimensions();
    const showRemaining = useSetting('usageLimitShowRemaining');
    const limitChips = getUsageLimitChips(props.usageLimits, windowWidth < LIMIT_CHIP_COLLAPSE_WIDTH);
    const limitStatusColor = (status: UsageLimitStatus): string | undefined => {
        if (status === 'rejected') return theme.colors.warningCritical;
        if (status === 'allowed_warning') return theme.colors.warning;
        return undefined;
    };

    return (
        <View style={styles.wrapper}>
            {openMenu === 'model' ? (
                <StatusOptionMenu
                    options={availableModels}
                    selectedKey={props.modelMode?.key ?? null}
                    onSelect={(model) => {
                        hapticsLight();
                        props.onModelModeChange?.(model);
                        setOpenMenu(null);
                    }}
                />
            ) : null}
            {openMenu === 'effort' ? (
                <StatusOptionMenu
                    options={availableEffortLevels}
                    selectedKey={props.effortLevel?.key ?? null}
                    onSelect={(level) => {
                        hapticsLight();
                        props.onEffortLevelChange?.(level);
                        setOpenMenu(null);
                    }}
                />
            ) : null}
            {openMenu === 'limits' ? (
                <UsageLimitMenu usageLimits={props.usageLimits} statusColor={limitStatusColor} showRemaining={showRemaining} />
            ) : null}
            <View style={styles.container}>
                <View style={styles.leftCluster}>
                    {props.gitBranch ? (
                        <StatusChip icon="git-branch-outline" text={props.gitBranch} wide />
                    ) : null}
                </View>
                <View style={styles.rightCluster}>
                    {props.modelLabel ? (
                        <StatusChip
                            icon="hardware-chip-outline"
                            text={props.modelLabel}
                            active={openMenu === 'model'}
                            onPress={canSelectModel ? () => setOpenMenu((current) => current === 'model' ? null : 'model') : undefined}
                        />
                    ) : null}
                    {props.effortLabel ? (
                        <StatusChip
                            icon="flash-outline"
                            text={props.effortLabel}
                            active={openMenu === 'effort'}
                            onPress={canSelectEffort ? () => setOpenMenu((current) => current === 'effort' ? null : 'effort') : undefined}
                        />
                    ) : null}
                    {limitChips.map((chip) => (
                        <StatusChip
                            key={chip.id}
                            icon="speedometer-outline"
                            text={`${chip.shortLabel} ${getUsageLimitDisplayPercentage(chip.utilization, showRemaining)}%`}
                            tint={limitStatusColor(chip.status)}
                            active={openMenu === 'limits'}
                            onPress={() => setOpenMenu((current) => current === 'limits' ? null : 'limits')}
                        />
                    ))}
                    {contextMaxValue !== null ? (
                        <ContextUsageCircle
                            value={contextValue}
                            maxValue={contextMaxValue}
                            percentage={contextPercentage}
                            color={contextColor}
                        />
                    ) : null}
                </View>
            </View>
        </View>
    );
}

function StatusOptionMenu<TOption extends ModeOption>(props: {
    options: TOption[];
    selectedKey: string | null;
    onSelect: (option: TOption) => void;
}) {
    const styles = stylesheet;
    const { theme } = useUnistyles();

    const options = (
        <ScrollView style={styles.menuScroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
                {props.options.map((option) => {
                    const isSelected = option.key === props.selectedKey;

                    return (
                        <Pressable
                            key={option.key}
                            onPress={() => props.onSelect(option)}
                            style={({ pressed }) => [
                                styles.menuItem,
                                pressed && styles.menuItemPressed,
                            ]}
                        >
                            <View style={[
                                styles.menuRadio,
                                isSelected && styles.menuRadioSelected,
                            ]}>
                                {isSelected ? (
                                    <View style={styles.menuRadioDot} />
                                ) : null}
                            </View>
                            <View style={styles.menuItemTextColumn}>
                                <Text
                                    style={[
                                        styles.menuItemText,
                                        isSelected && { color: theme.colors.radio.active },
                                    ]}
                                    numberOfLines={1}
                                    ellipsizeMode="tail"
                                >
                                    {option.name}
                                </Text>
                                {!!option.description && (
                                    <Text style={styles.menuItemDescription} numberOfLines={2}>
                                        {option.description}
                                    </Text>
                                )}
                            </View>
                        </Pressable>
                    );
                })}
        </ScrollView>
    );

    if (Platform.OS === 'web') {
        return <View style={styles.webMenu}>{options}</View>;
    }

    return (
        <AnimatedPopup style={styles.menu}>
            <LocalBlurHalo borderRadius={18} expansion={12} />
            <MobileGlassSurface enabled nativeEffect intensity={84} glassEffectStyle="regular" style={styles.menuGlass}>
                {options}
            </MobileGlassSurface>
        </AnimatedPopup>
    );
}

function formatResetTime(ms: number): string {
    const d = new Date(ms);
    if (ms - Date.now() < 22 * 3600_000) {
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function UsageLimitMenu(props: {
    usageLimits: UsageLimitsLike;
    statusColor: (status: UsageLimitStatus) => string | undefined;
    showRemaining: boolean;
}) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const rows = getUsageLimitRows(props.usageLimits);
    const knownLabels: Record<string, string> = {
        five_hour: t('components.sessionStatusBar.limitFiveHour'),
        seven_day: t('components.sessionStatusBar.limitSevenDay'),
    };

    return (
        <View style={styles.menu}>
            <View style={styles.limitMenuContent}>
                {rows.map((row) => (
                    <View key={row.id} style={styles.limitRow}>
                        <View
                            style={[
                                styles.limitDot,
                                { backgroundColor: props.statusColor(row.status) ?? theme.colors.status.connecting },
                            ]}
                        />
                        <Text style={styles.limitRowLabel} numberOfLines={1}>
                            {knownLabels[row.id] ?? row.label}
                        </Text>
                        <Text style={styles.limitRowValue}>
                            {row.utilization === null
                                ? '—'
                                : props.showRemaining
                                    // The bare chip percentage is ambiguous once it can mean
                                    // either direction, so the popover spells this one out.
                                    ? t('components.sessionStatusBar.limitRemaining', {
                                        percent: getUsageLimitDisplayPercentage(row.utilization, true),
                                    })
                                    : `${row.utilization}%`}
                        </Text>
                        {row.resetsAt !== null ? (
                            <Text style={styles.limitRowReset} numberOfLines={1}>
                                {t('components.sessionStatusBar.limitResets', { time: formatResetTime(row.resetsAt) })}
                            </Text>
                        ) : null}
                    </View>
                ))}
                {props.usageLimits ? (
                    <Text style={styles.limitFooter}>
                        {t('components.sessionStatusBar.limitAsOf', {
                            age: formatUsageLimitAge(props.usageLimits.capturedAt, Date.now()),
                        })}
                    </Text>
                ) : null}
            </View>
        </View>
    );
}

function ContextUsageCircle(props: {
    value: number;
    maxValue: number;
    percentage: number;
    color: string;
}) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const size = 18;
    const strokeWidth = 3;
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;
    const progress = props.maxValue > 0 ? Math.min(100, Math.max(0, props.percentage)) : 0;
    const dashOffset = circumference * (1 - progress / 100);
    const accessibilityLabel = t('components.sessionStatusBar.contextUsage', {
        used: props.value.toLocaleString(),
        total: props.maxValue.toLocaleString(),
        percent: Math.round(progress),
    });

    return (
        <View style={styles.contextCircle} accessibilityLabel={accessibilityLabel}>
            <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
                <Circle
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    stroke={theme.colors.divider}
                    strokeWidth={strokeWidth}
                    fill="none"
                />
                <Circle
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    stroke={props.color}
                    strokeWidth={strokeWidth}
                    fill="none"
                    strokeLinecap="round"
                    strokeDasharray={`${circumference} ${circumference}`}
                    strokeDashoffset={dashOffset}
                    rotation="-90"
                    originX={size / 2}
                    originY={size / 2}
                />
            </Svg>
        </View>
    );
}

function StatusChip(props: {
    icon: StatusIconName;
    text: string;
    onPress?: () => void;
    active?: boolean;
    wide?: boolean;
    /** Overrides the idle color, e.g. warning tint on limit chips. */
    tint?: string;
}) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const tint = props.active ? theme.colors.radio.active : (props.tint ?? theme.colors.textSecondary);
    const content = (
        <>
            <Ionicons name={props.icon} size={13} color={tint} />
            <Text
                style={[styles.chipText, props.wide && styles.chipTextWide, (props.active || props.tint) && { color: tint }]}
                numberOfLines={1}
                ellipsizeMode="middle"
            >
                {props.text}
            </Text>
        </>
    );

    if (props.onPress) {
        return (
            <Pressable
                style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
                onPress={props.onPress}
                hitSlop={8}
            >
                {content}
            </Pressable>
        );
    }

    return (
        <View style={styles.chip}>
            {content}
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    wrapper: {
        position: 'relative',
        width: '100%',
        zIndex: 20,
    },
    container: {
        width: '100%',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 6,
        // 16 matches AgentInput statusContainer so the branch/model chips
        // align with the online / permission-mode row above the composer
        paddingHorizontal: 16,
        paddingTop: 4,
        paddingBottom: 2,
        flexWrap: 'nowrap',
    },
    leftCluster: {
        minWidth: 0,
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-start',
    },
    rightCluster: {
        // Shrinkable so added chips compress (ellipsize) instead of pushing
        // the row off-screen — the container row is flexWrap:'nowrap'.
        flexShrink: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 12,
    },
    chip: {
        minHeight: 24,
        maxWidth: '100%',
        flexShrink: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingVertical: 3,
    },
    chipPressed: {
        opacity: 0.6,
    },
    chipText: {
        minWidth: 0,
        maxWidth: 168,
        flexShrink: 1,
        color: theme.colors.textSecondary,
        fontSize: 12,
        fontWeight: '500',
    },
    chipTextWide: {
        maxWidth: 360,
    },
    contextCircle: {
        width: 18,
        height: 18,
        flexShrink: 0,
        alignItems: 'center',
        justifyContent: 'center',
    },
    menu: {
        position: 'absolute',
        right: 8,
        bottom: 36,
        width: 236,
        maxWidth: '72%',
        maxHeight: 280,
        zIndex: 30,
        overflow: 'visible',
        borderRadius: 12,
        backgroundColor: 'transparent',
        ...Platform.select({
            web: {
                boxShadow: '0 4px 20px rgba(0, 0, 0, 0.18)',
            },
            default: {
                shadowColor: theme.colors.shadow.color,
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: theme.colors.shadow.opacity,
                shadowRadius: 10,
                elevation: 8,
            },
        }),
    },
    webMenu: {
        position: 'absolute',
        right: 8,
        bottom: 36,
        width: 236,
        maxWidth: '72%',
        maxHeight: 280,
        zIndex: 30,
        overflow: 'hidden',
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.18)',
    },
    menuGlass: {
        maxHeight: 280,
        overflow: 'hidden',
        borderRadius: 18,
        borderWidth: Platform.select({ web: 1, default: StyleSheet.hairlineWidth }),
        borderColor: Platform.select({ web: theme.colors.divider, default: theme.colors.glass.border }),
        backgroundColor: Platform.select({ web: theme.colors.surface, android: theme.colors.glass.backgroundStrong, default: 'transparent' }),
    },
    menuScroll: {
        maxHeight: 280,
    },
    menuItem: {
        minHeight: 42,
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 10,
        paddingHorizontal: 12,
        paddingVertical: 9,
    },
    menuItemPressed: {
        backgroundColor: Platform.select({ web: theme.colors.surfacePressed, default: theme.colors.glass.backgroundSubtle }),
    },
    menuRadio: {
        width: 14,
        height: 14,
        borderRadius: 7,
        borderWidth: 2,
        borderColor: theme.colors.radio.inactive,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 2,
    },
    menuRadioSelected: {
        borderColor: theme.colors.radio.active,
    },
    menuRadioDot: {
        width: 5,
        height: 5,
        borderRadius: 3,
        backgroundColor: theme.colors.radio.dot,
    },
    menuItemTextColumn: {
        minWidth: 0,
        flex: 1,
    },
    menuItemText: {
        color: theme.colors.text,
        fontSize: 13,
        fontWeight: '500',
    },
    menuItemDescription: {
        marginTop: 2,
        color: theme.colors.textSecondary,
        fontSize: 11,
        lineHeight: 14,
    },
    limitMenuContent: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        gap: 6,
    },
    limitRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minHeight: 22,
    },
    limitDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
        flexShrink: 0,
    },
    limitRowLabel: {
        color: theme.colors.text,
        fontSize: 13,
        fontWeight: '500',
        flexShrink: 1,
        minWidth: 0,
    },
    limitRowValue: {
        color: theme.colors.text,
        fontSize: 13,
        fontVariant: ['tabular-nums'],
        marginLeft: 'auto',
    },
    limitRowReset: {
        color: theme.colors.textSecondary,
        fontSize: 11,
        flexShrink: 0,
    },
    limitFooter: {
        marginTop: 2,
        color: theme.colors.textSecondary,
        fontSize: 11,
    },
}));
