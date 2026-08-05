import * as React from 'react';
import { Modal, Platform, Pressable, Text, useWindowDimensions, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { hapticsLight } from '@/components/haptics';
import type { SessionTaskPermissionController } from '@/hooks/useSessionTaskPermission';
import type { TaskPermissionLevel } from '@/utils/taskPermissionModes';

export type SessionComposerPermissionSelectorConfig = SessionTaskPermissionController & {
    compact?: boolean;
};

const LEVELS: TaskPermissionLevel[] = ['confirm', 'full-access'];

function labelForLevel(level: TaskPermissionLevel | null): string {
    if (level === 'full-access') {
        return t('agentInput.taskPermission.fullAccess');
    }
    return t('agentInput.taskPermission.confirm');
}

function shortLabelForLevel(level: TaskPermissionLevel | null): string {
    if (level === 'full-access') {
        return t('agentInput.taskPermission.fullAccessShort');
    }
    return t('agentInput.taskPermission.confirmShort');
}

function descriptionForLevel(level: TaskPermissionLevel): string {
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
    const [selecting, setSelecting] = React.useState(false);
    const triggerRef = React.useRef<any>(null);
    const firstOptionRef = React.useRef<any>(null);
    const wasOpenRef = React.useRef(false);
    const [anchor, setAnchor] = React.useState<{ x: number; y: number; width: number; height: number } | null>(null);
    const enabled = props.online && props.supported && !selecting;
    const currentFullLabel = props.supported
        ? labelForLevel(props.level)
        : t('agentInput.taskPermission.unavailable');
    const currentTriggerLabel = props.supported
        ? shortLabelForLevel(props.level)
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

    const dialogWidth = Math.min(390, Math.max(0, viewportWidth - 32));

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
                onPress={openPicker}
                hitSlop={6}
                style={({ pressed }) => [
                    styles.trigger,
                    !enabled && styles.triggerDisabled,
                    pressed && styles.triggerPressed,
                ]}
            >
                <Ionicons
                    name={props.level === 'full-access' ? 'warning-outline' : 'shield-checkmark-outline'}
                    size={14}
                    color={props.level === 'full-access' ? theme.colors.warning : theme.colors.textSecondary}
                />
                <Text
                    testID="session-composer-permission-trigger-label"
                    style={[styles.triggerText, props.compact && styles.triggerTextCompact]}
                    numberOfLines={1}
                >
                    {currentTriggerLabel}
                </Text>
                {enabled && !props.compact ? (
                    <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={11} color={theme.colors.textSecondary} />
                ) : null}
            </Pressable>
            {props.unavailableReason ? (
                <Text testID="session-composer-permission-disabled-reason" style={styles.disabledReason} numberOfLines={1}>
                    {props.unavailableReason}
                </Text>
            ) : null}

            <Modal
                visible={open}
                transparent
                animationType="fade"
                statusBarTranslucent
                onRequestClose={() => setOpen(false)}
            >
                <View style={styles.modalRoot}>
                    <Pressable style={styles.modalBackdrop} onPress={() => setOpen(false)} />
                    <View
                        role="dialog"
                        accessibilityLabel={t('agentInput.taskPermission.title')}
                        testID="session-composer-permission-picker"
                        style={[
                            styles.pickerSurface,
                            anchor
                                ? {
                                    position: 'absolute',
                                    right: Math.max(8, viewportWidth - (anchor.x + anchor.width)),
                                    bottom: Math.max(8, viewportHeight - anchor.y + 8),
                                }
                                : styles.pickerSurfaceFallback,
                            { width: dialogWidth, maxHeight: Math.max(0, viewportHeight - 64) },
                        ]}
                    >
                        <Text style={styles.pickerTitle}>{t('agentInput.taskPermission.title')}</Text>
                        <Text style={styles.pickerHint}>{t('agentInput.taskPermission.changesNextMessages')}</Text>
                        <View accessibilityRole="radiogroup">
                            {LEVELS.map((level) => {
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
                                        style={({ pressed }) => [styles.option, pressed && styles.optionPressed]}
                                    >
                                        <Ionicons
                                            name={selected ? 'checkmark-circle' : 'ellipse-outline'}
                                            size={18}
                                            color={selected ? theme.colors.button.primary.background : theme.colors.textSecondary}
                                        />
                                        <View style={styles.optionCopy}>
                                            <Text style={styles.optionLabel}>{label}</Text>
                                            <Text style={styles.optionDescription}>{description}</Text>
                                        </View>
                                    </Pressable>
                                );
                            })}
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
        alignItems: 'flex-end',
        marginLeft: 2,
    },
    trigger: {
        minWidth: 0,
        width: '100%',
        height: 32,
        paddingHorizontal: 7,
        borderRadius: 9,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 4,
    },
    triggerDisabled: {
        opacity: 0.58,
    },
    triggerPressed: {
        backgroundColor: theme.colors.surfaceHigh,
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
        padding: 12,
        borderRadius: 16,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.input.background,
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
    pickerTitle: {
        color: theme.colors.text,
        fontSize: 15,
        ...Typography.default('semiBold'),
    },
    pickerHint: {
        marginTop: 2,
        marginBottom: 8,
        color: theme.colors.textSecondary,
        fontSize: 12,
        ...Typography.default(),
    },
    option: {
        minHeight: 58,
        paddingHorizontal: 8,
        paddingVertical: 8,
        borderRadius: 12,
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 9,
    },
    optionPressed: {
        backgroundColor: theme.colors.surfaceHigh,
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
