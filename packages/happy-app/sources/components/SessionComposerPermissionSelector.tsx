import * as React from 'react';
import { Modal, Platform, Pressable, Text, useWindowDimensions, View } from 'react-native';
import { PermissionModeIcon } from './PermissionModeIcon';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { hapticsLight } from '@/components/haptics';
import { ComposerTooltip } from './DesktopShortcutTooltip';
import type { SessionTaskPermissionController } from '@/hooks/useSessionTaskPermission';
import type { TaskPermissionLevel } from '@/utils/taskPermissionModes';

export type SessionComposerPermissionSelectorConfig = SessionTaskPermissionController & {
    compact?: boolean;
    extraModes?: { key: string; label: string; onSelect: () => void }[];
};

const LEVELS: TaskPermissionLevel[] = ['confirm', 'automatic', 'full-access'];

function labelForLevel(level: TaskPermissionLevel | null): string {
    if (level === 'full-access') {
        return t('agentInput.taskPermission.fullAccess');
    }
    if (level === 'automatic') return t('agentInput.taskPermission.automatic');
    return t('agentInput.taskPermission.confirm');
}

function shortLabelForLevel(level: TaskPermissionLevel | null): string {
    if (level === 'full-access') {
        return t('agentInput.taskPermission.fullAccessShort');
    }
    if (level === 'automatic') return t('agentInput.taskPermission.automatic');
    return t('agentInput.taskPermission.confirmShort');
}

function descriptionForLevel(level: TaskPermissionLevel): string {
    if (level === 'automatic') return t('agentInput.taskPermission.automaticDescription');
    return level === 'full-access'
        ? t('agentInput.taskPermission.fullAccessDescription')
        : t('agentInput.taskPermission.confirmDescription');
}

export const SessionComposerPermissionSelector = React.memo(function SessionComposerPermissionSelector(
    props: SessionComposerPermissionSelectorConfig,
) {
    const { theme } = useUnistyles();
    const { width: viewportWidth, height: viewportHeight } = useWindowDimensions();
    const [open, setOpen] = React.useState(false);
    const [hovered, setHovered] = React.useState(false);
    const [hoveredLevel, setHoveredLevel] = React.useState<TaskPermissionLevel | null>(null);
    const [showExtraModes, setShowExtraModes] = React.useState(false);
    const [hoveredExtraMode, setHoveredExtraMode] = React.useState<string | null>(null);
    const [extraHovered, setExtraHovered] = React.useState(false);
    const [selecting, setSelecting] = React.useState(false);
    const triggerRef = React.useRef<any>(null);
    const firstOptionRef = React.useRef<any>(null);
    const wasOpenRef = React.useRef(false);
    const [anchor, setAnchor] = React.useState<{ x: number; y: number; width: number; height: number } | null>(null);
    const enabled = props.online && props.supported && !selecting;
    const legacyLabel = props.currentMode === 'read-only' ? t('agentInput.codexPermissionMode.readOnly') : t('agentInput.codexPermissionMode.default');
    const currentFullLabel = props.supported
        ? (props.supportsAutomatic && props.level === null ? legacyLabel : labelForLevel(props.level))
        : t('agentInput.taskPermission.unavailable');
    const currentTriggerLabel = props.supported
        ? (props.supportsAutomatic && props.level === null ? legacyLabel : shortLabelForLevel(props.level))
        : t('agentInput.taskPermission.unavailable');

    React.useEffect(() => {
        if (!enabled) {
            setOpen(false);
        }
    }, [enabled]);

    React.useEffect(() => {
        if (Platform.OS !== 'web') {
            wasOpenRef.current = open;
            return;
        }
        const wasOpen = wasOpenRef.current;
        wasOpenRef.current = open;
        const timeout = setTimeout(() => {
            if (open) {
                firstOptionRef.current?.focus?.();
            } else if (wasOpen) {
                triggerRef.current?.focus?.();
            }
        }, 0);
        return () => clearTimeout(timeout);
    }, [open]);

    React.useEffect(() => {
        if (Platform.OS !== 'web' || !open || typeof window === 'undefined') {
            return;
        }
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [open]);

    const openPicker = React.useCallback(() => {
        if (!enabled) return;
        hapticsLight();
        setHoveredLevel(null);
        setShowExtraModes(false);
        setExtraHovered(false);
        setHoveredExtraMode(null);
        const node = triggerRef.current;
        if (node && typeof node.measureInWindow === 'function') {
            node.measureInWindow((x: number, y: number, width: number, height: number) => {
                setAnchor({ x, y, width, height });
                setOpen(true);
            });
            return;
        }
        setAnchor(null);
        setOpen(true);
    }, [enabled]);

    const selectLevel = React.useCallback(async (level: TaskPermissionLevel) => {
        if (!enabled || level === props.level) {
            setOpen(false);
            return;
        }
        setOpen(false);
        setSelecting(true);
        try {
            await props.onLevelChange(level);
        } finally {
            setSelecting(false);
            if (Platform.OS === 'web') {
                setTimeout(() => triggerRef.current?.focus?.(), 0);
            }
        }
    }, [enabled, props.level, props.onLevelChange]);

    const dialogWidth = Math.min(336, Math.max(0, viewportWidth - 32));

    return (
        <View
            testID="session-composer-permission-selector"
            style={[styles.container, { maxWidth: props.compact ? 112 : 148 }]}
        >
            <Pressable
                ref={triggerRef}
                collapsable={false}
                testID="session-composer-permission-trigger"
                accessibilityRole="button"
                accessibilityLabel={`${t('agentInput.taskPermission.title')}: ${currentFullLabel}`}
                accessibilityHint={enabled ? t('agentInput.taskPermission.changesNextMessages') : (props.unavailableReason ?? undefined)}
                accessibilityState={{ disabled: !enabled, expanded: open }}
                aria-expanded={open}
                disabled={!enabled}
                onPress={() => { setHovered(false); openPicker(); }}
                onHoverIn={() => setHovered(true)}
                onHoverOut={() => setHovered(false)}
                hitSlop={6}
                style={({ pressed }) => [
                    styles.trigger,
                    !enabled && styles.triggerDisabled,
                    (pressed || hovered) && styles.triggerPressed,
                ]}
            >
                <PermissionModeIcon
                    level={props.level}
                    size={18}
                    color={props.level === 'full-access' ? theme.colors.permission.fullAccess : theme.colors.textSecondary}
                />
                <Text
                    testID="session-composer-permission-trigger-label"
                    style={[styles.triggerText, props.compact && styles.triggerTextCompact, props.level === 'full-access' && { color: theme.colors.permission.fullAccess }]}
                    numberOfLines={1}
                >
                    {currentTriggerLabel}
                </Text>

            </Pressable>
            <ComposerTooltip testID="session-composer-permission-tooltip" label={t('agentInput.taskPermission.title')} visible={Platform.OS === 'web' && hovered && !open} />
            {props.online && props.unavailableReason ? (
                <Text testID="session-composer-permission-disabled-reason" style={styles.disabledReason} numberOfLines={1}>
                    {props.unavailableReason}
                </Text>
            ) : null}

            <Modal
                visible={open}
                transparent
                animationType={Platform.OS === 'web' ? 'none' : 'fade'}
                statusBarTranslucent
                onRequestClose={() => setOpen(false)}
            >
                <View style={styles.modalRoot}>
                    <Pressable testID="session-composer-permission-scrim" style={styles.modalBackdrop} onPress={() => setOpen(false)} />
                    <View
                        role="dialog"
                        accessibilityLabel={t('agentInput.taskPermission.title')}
                        testID="session-composer-permission-picker"
                        style={[
                            styles.pickerSurface,
                            anchor
                                ? {
                                    position: 'absolute',
                                    left: Math.max(8, Math.min(anchor.x, viewportWidth - dialogWidth - 8)),
                                    bottom: Math.max(8, viewportHeight - anchor.y + 8),
                                }
                                : styles.pickerSurfaceFallback,
                            { width: dialogWidth, maxHeight: Math.max(0, viewportHeight - 64) },
                        ]}
                    >
                        <View style={styles.pickerHeader}>
                            <Text style={styles.pickerTitle}>{t('agentInput.taskPermission.pickerTitle')}</Text>
                            {!!props.extraModes?.length && <Pressable
                                testID="session-composer-permission-more"
                                accessibilityRole="button"
                                accessibilityState={{ expanded: showExtraModes }}
                                onPress={() => setShowExtraModes(value => !value)}
                                onHoverIn={() => setExtraHovered(true)}
                                onHoverOut={() => setExtraHovered(false)}
                                style={({ pressed }) => [styles.moreButton, (pressed || extraHovered) && styles.optionPressed]}
                            ><Text style={styles.moreText}>{t('agentInput.taskPermission.moreOptions')}</Text></Pressable>}
                        </View>
                        <View accessibilityRole="radiogroup">
                            {LEVELS.filter(level => level !== 'automatic' || props.supportsAutomatic).map((level) => {
                                const selected = level === props.level;
                                const label = labelForLevel(level);
                                const description = descriptionForLevel(level);
                                return (
                                    <Pressable
                                        ref={level === 'confirm' ? firstOptionRef : undefined}
                                        key={level}
                                        testID={`session-composer-permission-option-${level}`}
                                        accessibilityRole="radio"
                                        accessibilityState={{ checked: selected }}
                                        aria-checked={selected}
                                        accessibilityLabel={`${label}. ${description}`}
                                        onPress={() => void selectLevel(level)}
                                        {...(Platform.OS === 'web' ? { onKeyDown: (event: React.KeyboardEvent) => {
                                            if (event.key === ' ' && !event.repeat) {
                                                event.preventDefault();
                                                void selectLevel(level);
                                            }
                                        } } : {})}
                                        onHoverIn={() => setHoveredLevel(level)}
                                        onHoverOut={() => setHoveredLevel(null)}
                                        style={({ pressed }) => [styles.option, (pressed || hoveredLevel === level) && styles.optionPressed]}
                                    >
                                        <PermissionModeIcon level={level} color={level === 'full-access' ? theme.colors.permission.fullAccess : theme.colors.textSecondary} />
                                        <View style={styles.optionCopy}>
                                            <Text style={[styles.optionLabel, level === 'full-access' && { color: theme.colors.permission.fullAccess }]}>{label}</Text>
                                            <Text style={[styles.optionDescription, level === 'full-access' && { color: theme.colors.permission.fullAccess }]}>{description}</Text>
                                        </View>
                                        <View style={styles.checkmark}>
                                            {selected && <Ionicons name="checkmark" size={18} color={level === 'full-access' ? theme.colors.permission.fullAccess : theme.colors.text} />}
                                        </View>
                                    </Pressable>
                                );
                            })}
                            {showExtraModes && props.extraModes?.map(mode => <Pressable
                                key={mode.key}
                                testID={`session-composer-permission-extra-${mode.key}`}
                                accessibilityRole="radio"
                                accessibilityState={{ checked: props.currentMode === mode.key }}
                                onPress={() => { setOpen(false); mode.onSelect(); }}
                                {...(Platform.OS === 'web' ? { onKeyDown: (event: React.KeyboardEvent) => {
                                    if (event.key === ' ' && !event.repeat) {
                                        event.preventDefault();
                                        setOpen(false);
                                        mode.onSelect();
                                    }
                                } } : {})}
                                onHoverIn={() => setHoveredExtraMode(mode.key)}
                                onHoverOut={() => setHoveredExtraMode(null)}
                                style={({ pressed }) => [styles.extraOption, (pressed || hoveredExtraMode === mode.key) && styles.optionPressed]}
                            ><Text style={styles.optionDescription}>{mode.label}</Text>{props.currentMode === mode.key && <Ionicons name="checkmark" size={18} color={theme.colors.text} />}</Pressable>)}
                        </View>
                    </View>
                </View>
            </Modal>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        minWidth: 0,
        flexShrink: 1,
        alignItems: 'flex-start',
        marginLeft: 2,
    },
    trigger: {
        minWidth: 0,
        width: '100%',
        height: 32,
        paddingHorizontal: 7,
        borderRadius: 16,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-start',
        gap: 4,
    },
    triggerDisabled: {
        opacity: 0.58,
    },
    triggerPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    triggerText: {
        minWidth: 0,
        flexShrink: 1,
        color: theme.colors.textSecondary,
        fontSize: 12,
        ...Typography.default('semiBold'),
    },
    triggerTextCompact: {
        fontSize: 11,
    },
    disabledReason: {
        color: theme.colors.textSecondary,
        fontSize: 10,
        maxWidth: '100%',
        paddingHorizontal: 4,
        ...Typography.default(),
    },
    modalRoot: {
        flex: 1,
    },
    modalBackdrop: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
    },
    pickerSurface: {
        padding: 8,
        borderRadius: 16,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        overflow: 'hidden',
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 12,
        elevation: 8,
    },
    pickerSurfaceFallback: {
        alignSelf: 'center',
        marginTop: 120,
    },
    pickerHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    moreButton: { paddingHorizontal: 7, paddingVertical: 5, borderRadius: 6 },
    moreText: { color: theme.colors.textSecondary, fontSize: 11, ...Typography.default() },
    extraOption: { minHeight: 34, paddingHorizontal: 8, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderRadius: 8 },
    pickerTitle: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        paddingHorizontal: 8,
        paddingTop: 3,
        paddingBottom: 7,
        ...Typography.default(),
    },
    checkmark: { width: 18, alignSelf: 'center' },
    option: {
        minHeight: 52,
        paddingHorizontal: 8,
        paddingVertical: 8,
        borderRadius: 12,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    optionPressed: {
        backgroundColor: theme.colors.surfacePressed,
    },
    optionCopy: {
        flex: 1,
        minWidth: 0,
    },
    optionLabel: {
        color: theme.colors.text,
        fontSize: 14,
        ...Typography.default('semiBold'),
    },
    optionDescription: {
        marginTop: 2,
        color: theme.colors.textSecondary,
        fontSize: 12,
        lineHeight: 16,
        ...Typography.default(),
    },
}));
