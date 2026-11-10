import * as React from 'react';
import { Modal, Pressable, Text, useWindowDimensions, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { ModeOption } from '@/components/modelModeOptions';
import { PickerContent, type PickerItem } from '@/components/SessionConfigPanel';
import { hapticsLight } from '@/components/haptics';

type ActivePicker = 'model' | 'effort' | null;

export type SessionComposerModeSelectorConfig = {
    online: boolean;
    model: ModeOption | null;
    modelOptions: ModeOption[];
    effort: ModeOption | null;
    effortOptions: ModeOption[];
    onModelChange: (key: string) => void;
    onEffortChange: (key: string) => void;
    fastMode?: boolean;
    supportsFast?: boolean;
    onFastModeChange?: (enabled: boolean) => void;
};

function toPickerItems(options: ModeOption[]): PickerItem[] {
    return options.map((option) => ({
        key: option.key,
        label: option.name,
        subtitle: option.description ?? undefined,
    }));
}

export const SessionComposerModeSelector = React.memo(function SessionComposerModeSelector(
    props: SessionComposerModeSelectorConfig,
) {
    const { theme } = useUnistyles();
    const { width: viewportWidth, height: viewportHeight } = useWindowDimensions();
    const [activePicker, setActivePicker] = React.useState<ActivePicker>(null);
    const triggerRef = React.useRef<View>(null);
    const [anchor, setAnchor] = React.useState<{ x: number; y: number; width: number; height: number } | null>(null);
    const showEffort = props.effortOptions.length > 0 || props.effort !== null;
    const canChangeModel = props.online && props.modelOptions.length > 1;
    const canChangeEffort = showEffort && props.online && props.effortOptions.length > 1;
    const canChangeFast = props.online && props.supportsFast === true && !!props.onFastModeChange;

    React.useEffect(() => {
        if ((activePicker === 'model' && !canChangeModel) || (activePicker === 'effort' && !canChangeEffort)) {
            setActivePicker(null);
        }
    }, [activePicker, canChangeEffort, canChangeModel]);

    const modelItems = React.useMemo(() => toPickerItems(props.modelOptions), [props.modelOptions]);
    const effortItems = React.useMemo(() => toPickerItems(props.effortOptions), [props.effortOptions]);
    const unavailableReason = props.online ? t('settingsAccount.notAvailable') : t('newSession.machineOffline');
    const hasUnavailablePicker = !canChangeModel || (showEffort && !canChangeEffort);
    // The session header presents the shared offline state. Keep the model
    // controls accessible while avoiding a duplicate label in the composer.
    const disabledSummary = props.online && hasUnavailablePicker ? unavailableReason : null;

    const togglePicker = React.useCallback((type: Exclude<ActivePicker, null>) => {
        hapticsLight();
        if (activePicker === type) {
            setActivePicker(null);
            return;
        }

        const node = triggerRef.current;
        if (node && typeof node.measureInWindow === 'function') {
            node.measureInWindow((x, y, width, height) => {
                setAnchor({ x, y, width, height });
                setActivePicker(type);
            });
            return;
        }

        setAnchor(null);
        setActivePicker(type);
    }, [activePicker]);

    const selectModel = React.useCallback((key: string) => {
        props.onModelChange(key);
        setActivePicker(null);
    }, [props.onModelChange]);

    const selectEffort = React.useCallback((key: string) => {
        props.onEffortChange(key);
        setActivePicker(null);
    }, [props.onEffortChange]);

    const renderTrigger = (
        type: Exclude<ActivePicker, null>,
        title: string,
        value: string,
        enabled: boolean,
    ) => (
        <Pressable
            testID={`session-composer-${type}-trigger`}
            accessibilityRole="button"
            accessibilityLabel={`${title}: ${value}`}
            accessibilityHint={enabled ? undefined : unavailableReason}
            accessibilityState={{ disabled: !enabled, expanded: activePicker === type }}
            aria-expanded={activePicker === type}
            disabled={!enabled}
            onPress={() => togglePicker(type)}
            style={({ pressed }) => [
                styles.trigger,
                !enabled && styles.triggerDisabled,
                pressed && styles.triggerPressed,
            ]}
        >
            <Text style={styles.triggerText} numberOfLines={1}>
                {value}
            </Text>
            {enabled ? (
                <Ionicons
                    name={activePicker === type ? 'chevron-up' : 'chevron-down'}
                    size={11}
                    color={theme.colors.textSecondary}
                />
            ) : null}
        </Pressable>
    );

    const activeTitle = activePicker === 'model'
        ? t('agentInput.model.title')
        : t('agentInput.effort.title');
    const activeItems = activePicker === 'model' ? modelItems : effortItems;
    const activeKey = activePicker === 'model' ? props.model?.key : props.effort?.key;
    const handleSelect = activePicker === 'model' ? selectModel : selectEffort;
    const dialogWidth = Math.min(340, Math.max(0, viewportWidth - 32));

    return (
        <View
            ref={triggerRef}
            collapsable={false}
            testID="session-composer-mode-selector"
            style={[styles.container, { maxWidth: 220 }]}
        >
            <View style={styles.triggerRow}>
                {renderTrigger(
                    'model',
                    t('agentInput.model.title'),
                    props.model?.name ?? t('agentInput.model.title'),
                    canChangeModel,
                )}
                {showEffort ? (
                    <>
                        <Text style={styles.separator}>·</Text>
                        {renderTrigger(
                            'effort',
                            t('agentInput.effort.title'),
                            props.effort?.name ?? t('agentInput.effort.title'),
                            canChangeEffort,
                        )}
                    </>
                ) : null}
                {props.supportsFast ? (
                    <>
                        <Text style={styles.separator}>·</Text>
                        <Pressable
                            testID="session-composer-fast-toggle"
                            accessibilityRole="switch"
                            accessibilityLabel="Fast"
                            accessibilityState={{ checked: props.fastMode === true, disabled: !canChangeFast }}
                            aria-checked={props.fastMode === true}
                            disabled={!canChangeFast}
                            onPress={() => props.onFastModeChange?.(!props.fastMode)}
                            style={({ pressed }) => [styles.iconTrigger, !canChangeFast && styles.triggerDisabled, pressed && styles.triggerPressed]}
                        >
                            <Ionicons name="flash-outline" size={14} color={props.fastMode ? theme.colors.accent : theme.colors.textSecondary} />
                        </Pressable>
                    </>
                ) : null}
            </View>
            {disabledSummary ? (
                <Text testID="session-composer-disabled-reason" style={styles.disabledReason} numberOfLines={1}>
                    {disabledSummary}
                </Text>
            ) : null}

            <Modal
                visible={activePicker !== null}
                transparent
                animationType="fade"
                statusBarTranslucent
                onRequestClose={() => setActivePicker(null)}
            >
                <View style={styles.modalRoot}>
                    <Pressable
                        testID="session-composer-mode-picker-scrim"
                        style={styles.modalBackdrop}
                        onPress={() => setActivePicker(null)}
                    />
                    {activePicker ? (
                        <View
                            role="dialog"
                            testID={`session-composer-${activePicker}-picker`}
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
                            <Text style={styles.pickerTitle}>{activeTitle}</Text>
                            <PickerContent
                                title={activeTitle}
                                items={activeItems}
                                selectedKey={activeKey ?? null}
                                onSelect={handleSelect}
                                embedded
                            />
                        </View>
                    ) : null}
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
    triggerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        minWidth: 0,
        gap: 4,
        justifyContent: 'flex-end',
    },
    trigger: {
        flexDirection: 'row',
        alignItems: 'center',
        minWidth: 0,
        flexShrink: 1,
        gap: 3,
        borderRadius: 8,
        paddingHorizontal: 4,
        height: 24,
        maxWidth: '100%',
    },
    iconTrigger: {
        width: 24,
        height: 24,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 8,
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
    separator: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        ...Typography.default(),
    },
    disabledReason: {
        color: theme.colors.textSecondary,
        fontSize: 11,
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
        paddingHorizontal: 12,
        paddingBottom: 8,
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
        marginTop: 64,
    },
    pickerTitle: {
        color: theme.colors.text,
        fontSize: 14,
        paddingHorizontal: 4,
        paddingVertical: 12,
        ...Typography.default('semiBold'),
    },
}));
