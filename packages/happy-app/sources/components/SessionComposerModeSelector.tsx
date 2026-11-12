import * as React from 'react';
import {
    Animated,
    Easing,
    Modal,
    Platform,
    Pressable,
    ScrollView,
    Text,
    TextInput,
    useWindowDimensions,
    View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { ModeOption } from '@/components/modelModeOptions';
import { hapticsLight } from '@/components/haptics';

export type SessionComposerModeSelectorConfig = {
    online: boolean;
    unifiedCodex?: boolean;
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

function spaceActivation(action: () => void) {
    return Platform.OS === 'web'
        ? {
              onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
                  // RN Web handles Enter for switches/radios, but only handles Space for buttons.
                  if (event.key === ' ' && !event.repeat) {
                      event.preventDefault();
                      action();
                  }
              },
          }
        : {};
}

type ModePanelAnchor = { x: number; y: number; width: number; height: number };

export function getModePanelPlacement(width: number, height: number, anchor: ModePanelAnchor | null) {
    const panelWidth = Math.min(330, Math.max(0, width - 24));
    const left = anchor
        ? Math.max(8, Math.min(width - panelWidth - 8, anchor.x + anchor.width - panelWidth))
        : 12;
    if (!anchor) return { left, width: panelWidth, bottom: 64, maxHeight: Math.max(0, height - 76) };
    const above = Math.max(0, anchor.y - 16);
    const below = Math.max(0, height - anchor.y - anchor.height - 16);
    if (above < 200 && below > above) {
        return { left, width: panelWidth, top: Math.max(8, anchor.y + anchor.height + 8), maxHeight: below };
    }
    return { left, width: panelWidth, bottom: Math.max(8, height - anchor.y + 8), maxHeight: above };
}

export const SessionComposerModeSelector = React.memo(function SessionComposerModeSelector(
    props: SessionComposerModeSelectorConfig,
) {
    const { theme } = useUnistyles();
    const { width, height } = useWindowDimensions();
    const triggerRef = React.useRef<View>(null);
    const [open, setOpen] = React.useState(false);
    const shimmer = React.useRef(new Animated.Value(0)).current;
    React.useEffect(() => {
        if (!open || Platform.OS === 'web') return;
        shimmer.setValue(0);
        const animation = Animated.loop(Animated.timing(shimmer, {
            toValue: 1, duration: 5000, easing: Easing.linear, useNativeDriver: true,
        }));
        animation.start();
        return () => animation.stop();
    }, [open, shimmer]);
    const [modelHovered, setModelHovered] = React.useState(false);
    const [modelsOpen, setModelsOpen] = React.useState(false);
    const [search, setSearch] = React.useState('');
    const trackRef = React.useRef<View>(null);
    const [trackWidth, setTrackWidth] = React.useState(0);
    const dragIndex = React.useRef<number | null>(null);
    const [previewIndex, setPreviewIndex] = React.useState<number | null>(null);
    const [anchor, setAnchor] = React.useState<ModePanelAnchor | null>(null);
    const enabled =
        props.online &&
        (props.modelOptions.length > 1 ||
            props.effortOptions.length > 1 ||
            (props.supportsFast && !!props.onFastModeChange));
    const close = React.useCallback(() => {
        dragIndex.current = null;
        setPreviewIndex(null);
        setOpen(false);
        setModelsOpen(false);
        setSearch('');
    }, []);
    React.useEffect(() => {
        if (!enabled) close();
    }, [enabled, close]);
    React.useEffect(() => {
        dragIndex.current = null;
        setPreviewIndex(null);
    }, [props.model?.key, props.effortOptions]);
    React.useEffect(() => {
        if (!open || Platform.OS !== 'web' || typeof window === 'undefined') return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                close();
            }
        };
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('resize', close);
        return () => {
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('resize', close);
        };
    }, [open, close]);
    const toggle = () => {
        if (open) {
            close();
            return;
        }
        hapticsLight();
        const node = triggerRef.current;
        if (node && typeof node.measureInWindow === 'function') {
            node.measureInWindow((x, y, measuredWidth, measuredHeight) => {
                setAnchor({ x, y, width: measuredWidth, height: measuredHeight });
                setOpen(true);
            });
        } else {
            setAnchor(null);
            setOpen(true);
        }
    };
    const placement = getModePanelPlacement(width, height, anchor);
    const levels = props.effortOptions.filter((option) => option.key !== 'default').map((option) => ({
        ...option, name: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(option.key.toLowerCase()) ? option.key.toLowerCase() : option.name,
    }));
    const defaultOption = levels.find((option) => option.key === 'medium') ?? levels[0];
    const effectiveEffort = props.effort?.key === 'default' ? defaultOption : levels.find((level) => level.key === props.effort?.key) ?? props.effort;
    const selectedIndex = levels.findIndex((option) => option.key === effectiveEffort?.key);
    const effortIndex = previewIndex ?? selectedIndex;
    const effortFraction = levels.length > 1 && effortIndex >= 0 ? effortIndex / (levels.length - 1) : 0;
    const isUltra = levels[effortIndex]?.key?.toLowerCase() === 'ultra';
    const particleCount = effortIndex > 0 ? Math.round(4 + effortFraction * 18) : 0;
    const particleStyles = React.useMemo(() => Array.from({ length: 16 }, (_, particle) => {
        const phase = ((particle + 1) * 0.61803398875) % 1;
        const travel = Math.max(trackWidth, 1);
        return {
            left: 0 as const,
            top: 4 + ((particle * 17 + 5) % 24),
            transform: [{ translateX: shimmer.interpolate({
                inputRange: [0, phase, Math.min(phase + 0.0001, 1), 1],
                outputRange: [phase * travel, 0, travel, phase * travel],
            }) }],
        };
    }), [shimmer, trackWidth]);
    const slideTransition = Platform.OS === 'web' ? ({ transition: 'left 90ms ease-out, width 90ms ease-out' } as any) : undefined;
    const selectEffortAt = (offsetX: number) => {
        if (trackWidth <= 32 || levels.length === 0) return;
        const fraction = Math.max(0, Math.min(1, (offsetX - 16) / (trackWidth - 32)));
        const index = Math.round(fraction * (levels.length - 1));
        if (dragIndex.current !== index) {
            dragIndex.current = index;
            setPreviewIndex(index);
        }
    };
    const finishDrag = (commit: boolean) => {
        const option = dragIndex.current === null ? undefined : levels[dragIndex.current];
        dragIndex.current = null;
        setPreviewIndex(null);
        if (commit && option && option.key !== props.effort?.key) props.onEffortChange(option.key);
    };
    return (
        <View
            ref={triggerRef}
            collapsable={false}
            testID="session-composer-mode-selector"
            style={styles.container}
        >
            <Pressable
                testID="session-composer-mode-trigger"
                accessibilityRole="button"
                accessibilityLabel={`${t('agentInput.model.title')}: ${props.model?.name ?? ''}${effectiveEffort ? `, ${t('agentInput.effort.title')}: ${effectiveEffort.name}` : ''}${props.supportsFast && props.fastMode ? ', Fast' : ''}`}
                accessibilityHint={
                    enabled
                        ? undefined
                        : props.online
                          ? t('settingsAccount.notAvailable')
                          : t('newSession.machineOffline')
                }
                accessibilityState={{ disabled: !enabled, expanded: open }}
                aria-expanded={open}
                disabled={!enabled}
                onPress={toggle}
                style={({ pressed }) => [
                    styles.trigger,
                    !enabled && styles.disabled,
                    (open || pressed) && styles.selected,
                ]}
            >
                {props.supportsFast ? (
                    <Ionicons
                        name={props.fastMode ? 'flash' : 'flash-outline'}
                        size={14}
                        color={props.fastMode ? theme.colors.accent : theme.colors.textSecondary}
                    />
                ) : null}
                <Text style={styles.triggerText} numberOfLines={1}>
                    {props.model?.name ?? t('agentInput.model.title')}
                    {effectiveEffort ? <Text style={isUltra ? styles.ultraTitle : styles.triggerEffort}> {effectiveEffort.name}</Text> : null}
                </Text>
                {enabled ? (
                    <Ionicons
                        name={open ? 'chevron-up' : 'chevron-down'}
                        size={11}
                        color={theme.colors.textSecondary}
                    />
                ) : null}
            </Pressable>
            <Modal
                visible={open}
                transparent
                animationType="fade"
                statusBarTranslucent
                onRequestClose={close}
            >
                <View style={styles.modalRoot}>
                    <Pressable
                        testID="session-composer-mode-picker-scrim"
                        style={styles.backdrop}
                        onPress={close}
                        accessibilityLabel={t('devTools.close')}
                    />
                    {open ? (
                        <View
                            role="dialog"
                            accessibilityViewIsModal
                            testID="session-composer-mode-panel"
                            style={[styles.panel, { position: 'absolute', ...placement }]}
                        >
                            {modelsOpen ? (
                                <View style={styles.models}>
                                    <View style={styles.modelsHead}>
                                        <Pressable
                                            accessibilityRole="button"
                                            accessibilityLabel={t('common.back')}
                                            onPress={() => {
                                                setModelsOpen(false);
                                                setSearch('');
                                            }}
                                            style={styles.iconButton}
                                        >
                                            <Ionicons
                                                name="chevron-back"
                                                size={19}
                                                color={theme.colors.textSecondary}
                                            />
                                        </Pressable>
                                        <Text style={styles.modelsTitle}>{t('agentInput.model.title')}</Text>
                                        <Pressable
                                            accessibilityRole="button"
                                            accessibilityLabel={t('devTools.close')}
                                            onPress={close}
                                            style={styles.iconButton}
                                        >
                                            <Ionicons
                                                name="close"
                                                size={20}
                                                color={theme.colors.textSecondary}
                                            />
                                        </Pressable>
                                    </View>
                                    <TextInput
                                        testID="session-composer-model-search"
                                        value={search}
                                        onChangeText={setSearch}
                                        accessibilityLabel={t('tools.names.search')}
                                        placeholder={t('tools.names.search')}
                                        placeholderTextColor={theme.colors.textSecondary}
                                        style={styles.search}
                                    />
                                    <ScrollView
                                        style={[
                                            styles.modelList,
                                            {
                                                maxHeight: Math.max(
                                                    40,
                                                    Math.min(300, placement.maxHeight - 110),
                                                ),
                                            },
                                        ]}
                                        nestedScrollEnabled
                                        keyboardShouldPersistTaps="handled"
                                    >
                                        {props.modelOptions
                                            .filter((option) =>
                                                `${option.name} ${option.description ?? ''}`
                                                    .toLocaleLowerCase()
                                                    .includes(search.trim().toLocaleLowerCase()),
                                            )
                                            .map((option) => (
                                                <Pressable
                                                    key={option.key}
                                                    testID={`session-composer-model-${option.key}`}
                                                    {...spaceActivation(() => {
                                                        props.onModelChange(option.key);
                                                        setModelsOpen(false);
                                                        setSearch('');
                                                    })}
                                                    accessibilityRole="radio"
                                                    accessibilityLabel={
                                                        option.description
                                                            ? `${option.name}, ${option.description}`
                                                            : option.name
                                                    }
                                                    accessibilityState={{
                                                        checked: props.model?.key === option.key,
                                                    }}
                                                    aria-checked={props.model?.key === option.key}
                                                    onPress={() => {
                                                        props.onModelChange(option.key);
                                                        setModelsOpen(false);
                                                        setSearch('');
                                                    }}
                                                    style={({ pressed }) => [
                                                        styles.option,
                                                        props.model?.key === option.key && styles.selected,
                                                        pressed && styles.pressed,
                                                    ]}
                                                >
                                                    <View style={styles.grow}>
                                                        <Text style={styles.optionText}>{option.name}</Text>
                                                        {option.description ? (
                                                            <Text style={styles.description}>
                                                                {option.description}
                                                            </Text>
                                                        ) : null}
                                                    </View>
                                                    {props.model?.key === option.key ? (
                                                        <Ionicons
                                                            name="checkmark"
                                                            size={16}
                                                            color={theme.colors.accent}
                                                        />
                                                    ) : null}
                                                </Pressable>
                                            ))}
                                    </ScrollView>
                                </View>
                            ) : (
                                <View style={styles.settings}>
                                    <View style={styles.panelHead}>
                                        {(props.unifiedCodex || props.supportsFast) ? (
                                            <Pressable
                                                testID="session-composer-fast-toggle"
                                                {...spaceActivation(() =>
                                                    props.onFastModeChange?.(!props.fastMode),
                                                )}
                                                accessibilityRole="switch"
                                                accessibilityLabel="Fast"
                                                aria-checked={props.fastMode === true}
                                                accessibilityState={{
                                                    checked: props.fastMode === true,
                                                    disabled: !props.supportsFast || !props.onFastModeChange,
                                                }}
                                                disabled={!props.supportsFast || !props.onFastModeChange}
                                                onPress={() => props.onFastModeChange?.(!props.fastMode)}
                                                accessibilityHint={!props.supportsFast ? t('settingsAccount.notAvailable') : undefined}
                                                style={({ pressed }) => [
                                                    styles.iconButton,
                                                    props.fastMode && styles.selected,
                                                    pressed && styles.pressed,
                                                ]}
                                            >
                                                <Ionicons
                                                    name={props.fastMode ? 'flash' : 'flash-outline'}
                                                    size={20}
                                                    color={
                                                        props.fastMode
                                                            ? theme.colors.accent
                                                            : theme.colors.textSecondary
                                                    }
                                                />
                                            </Pressable>
                                        ) : (
                                            <View style={styles.iconButton} />
                                        )}
                                        <View style={styles.centerSlot}>
                                        <Pressable
                                            testID="session-composer-open-models"
                                            accessibilityRole="button"
                                            accessibilityState={{ disabled: props.modelOptions.length < 2 }}
                                            disabled={props.modelOptions.length < 2}
                                            onPress={() => setModelsOpen(true)}
                                            onHoverIn={() => setModelHovered(true)}
                                            onHoverOut={() => setModelHovered(false)}
                                            style={({ pressed }) => [styles.center, (pressed || modelHovered) && styles.centerHover]}
                                        >
                                            {effectiveEffort ? (
                                                <Text style={[styles.levelTitle, isUltra && styles.ultraTitle]}>
                                                    {previewIndex === null ? effectiveEffort.name : levels[previewIndex]?.name}
                                                </Text>
                                            ) : null}
                                            <Text style={styles.modelLink} numberOfLines={1}>
                                                {props.model?.name ?? t('agentInput.model.title')}
                                                {props.modelOptions.length > 1 ? '  ›' : ''}
                                            </Text>
                                        </Pressable>
                                        </View>
                                        <Pressable
                                            testID="session-composer-effort-reset"
                                            accessibilityRole="button"
                                            accessibilityLabel={defaultOption ? t('common.reset') : t('devTools.close')}
                                            accessibilityHint={defaultOption?.name}
                                            onPress={() => defaultOption ? props.onEffortChange(defaultOption.key) : close()}
                                            style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
                                        >
                                            <Ionicons
                                                name={defaultOption ? 'refresh-outline' : 'close'}
                                                size={20}
                                                color={theme.colors.textSecondary}
                                            />
                                        </Pressable>
                                    </View>
                                    {levels.length > 0 ? (
                                        <View
                                            ref={trackRef}
                                            collapsable={false}
                                            testID="session-composer-effort-track"
                                            style={styles.track}
                                            onLayout={(event) =>
                                                setTrackWidth(event.nativeEvent.layout.width)
                                            }
                                            {...(Platform.OS === 'web'
                                                ? {
                                                      onPointerDown: (event: any) => {
                                                          event.preventDefault();
                                                          event.currentTarget.setPointerCapture(
                                                              event.pointerId,
                                                          );
                                                          selectEffortAt(
                                                              event.clientX -
                                                                  event.currentTarget.getBoundingClientRect()
                                                                      .left,
                                                          );
                                                      },
                                                      onPointerMove: (event: any) => {
                                                          if (dragIndex.current !== null)
                                                              selectEffortAt(
                                                                  event.clientX -
                                                                      event.currentTarget.getBoundingClientRect()
                                                                          .left,
                                                              );
                                                      },
                                                      onPointerUp: () => finishDrag(true),
                                                      onPointerCancel: () => finishDrag(false),
                                                  }
                                                : {
                                                      onStartShouldSetResponderCapture: () => true,
                                                      onStartShouldSetResponder: () => true,
                                                      onResponderGrant: (event: any) => selectEffortAt(event.nativeEvent.locationX),
                                                      onResponderMove: (event: any) => selectEffortAt(event.nativeEvent.locationX),
                                                      onResponderRelease: () => finishDrag(true),
                                                      onResponderTerminate: () => finishDrag(false),
                                                  })}
                                        >
                                            {effortIndex > 0 ? (
                                                <View pointerEvents="none" style={[styles.fill, slideTransition, {
                                                    width: 16 + Math.max(0, trackWidth - 32) * effortFraction,
                                                }]}>
                                                    {isUltra ? (
                                                        <LinearGradient
                                                            colors={['#1647d6', '#8b70ff', '#ab62f5', '#7340f4']}
                                                            start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }}
                                                            style={StyleSheet.absoluteFillObject}
                                                        />
                                                    ) : null}
                                                    {Platform.OS === 'web' ? (
                                                        <>
                                                            {React.createElement('style', null,
                                                                '@keyframes paws-effort-star { from { transform: translate3d(0,0,0) } to { transform: translate3d(-100%,0,0) } }')}
                                                            {Array.from({ length: 22 }, (_, particle) => {
                                                                const phase = ((particle + 1) * 0.61803398875) % 1;
                                                                const duration = 3.2 + (particle % 5) * 0.08;
                                                                return React.createElement('div', {
                                                                    key: particle,
                                                                    'data-effort-particle': particle,
                                                                    style: {
                                                                        position: 'absolute', width: trackWidth, height: 3,
                                                                        top: 4 + ((particle * 17 + 5) % 24), left: 0,
                                                                        pointerEvents: 'none',
                                                                        opacity: particle < particleCount ? 0.48 + (particle % 4) * 0.14 : 0,
                                                                        animation: `paws-effort-star ${duration}s linear infinite`,
                                                                        animationDelay: `${-phase * duration}s`,
                                                                    },
                                                                }, React.createElement('div', { style: {
                                                                    position: 'absolute', left: '100%', width: 3, height: 3,
                                                                    borderRadius: '50%', background: '#fff',
                                                                    boxShadow: '0 0 4px rgba(255,255,255,.65)',
                                                                } }));
                                                            })}
                                                        </>
                                                    ) : particleStyles.map((style, particle) => (
                                                        <Animated.View key={particle} style={[styles.particle, style, {
                                                            opacity: particle < particleCount ? 0.48 + (particle % 4) * 0.14 : 0,
                                                        }]} />
                                                    ))}
                                                </View>
                                            ) : null}
                                            <View style={styles.steps}>
                                                {levels.map((option, index) => (
                                                    <Pressable
                                                        key={option.key}
                                                        testID={`session-composer-effort-${option.key}`}
                                                        {...spaceActivation(() =>
                                                            props.onEffortChange(option.key),
                                                        )}
                                                        accessibilityRole="radio"
                                                        accessibilityLabel={option.name}
                                                        aria-checked={props.effort?.key === option.key}
                                                        accessibilityState={{
                                                            checked: props.effort?.key === option.key,
                                                        }}
                                                        onPress={() => props.onEffortChange(option.key)}
                                                        style={[
                                                            styles.step,
                                                            {
                                                                left: `${levels.length > 1 ? (index * 100) / (levels.length - 1) : 0}%`,
                                                            },
                                                        ]}
                                                    >
                                                        <View
                                                            style={[
                                                                styles.dot,
                                                                index < effortIndex && styles.passed,
                                                            ]}
                                                        />
                                                    </Pressable>
                                                ))}
                                                {effortIndex >= 0 ? (
                                                    <View pointerEvents="none" testID="session-composer-effort-knob" style={[styles.knobPosition, slideTransition, {
                                                        left: `${effortFraction * 100}%`,
                                                    }]}><View style={styles.knob} /></View>
                                                ) : null}
                                            </View>
                                        </View>
                                    ) : null}
                                </View>
                            )}
                        </View>
                    ) : null}
                </View>
            </Modal>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: { minWidth: 0, flexShrink: 1, alignItems: 'flex-end' },
    trigger: {
        flexDirection: 'row',
        alignItems: 'center',
        minWidth: 0,
        flexShrink: 1,
        gap: 7,
        borderRadius: 10,
        paddingHorizontal: 12,
        height: 30,
        maxWidth: 280,
    },
    triggerText: {
        minWidth: 0,
        flexShrink: 1,
        color: theme.colors.textSecondary,
        fontSize: 13,
        ...Typography.default('semiBold'),
    },
    triggerEffort: { color: theme.colors.textSecondary, ...Typography.default() },
    disabled: { opacity: 0.58 },
    pressed: { backgroundColor: theme.colors.surfacePressed },
    modalRoot: { flex: 1 },
    backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    panel: {
        borderRadius: 20,
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
    settings: { paddingHorizontal: 18, paddingTop: 17, paddingBottom: 18 },
    panelHead: { flexDirection: 'row', alignItems: 'flex-start' },
    iconButton: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
    centerSlot: { flex: 1, alignItems: 'center', minWidth: 0 },
    center: { alignItems: 'center', maxWidth: '100%', borderRadius: 10, paddingVertical: 4, paddingHorizontal: 12 },
    centerHover: { backgroundColor: theme.colors.surfacePressed, shadowColor: theme.colors.shadow.color, shadowOffset: { width: 0, height: 2 }, shadowOpacity: theme.colors.shadow.opacity, shadowRadius: 5, elevation: 2 },
    levelTitle: {
        color: theme.colors.text,
        fontSize: 18,
        lineHeight: 24,
        ...Typography.default('semiBold'),
    },
    ultraTitle: { color: '#9348ff' },
    modelLink: { color: theme.colors.textSecondary, fontSize: 13, marginTop: 2, ...Typography.default() },
    track: {
        height: 32,
        marginTop: 18,
        borderRadius: 16,
        backgroundColor: theme.colors.slider.track,
    },
    fill: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: 0,
        borderTopLeftRadius: 16,
        borderBottomLeftRadius: 16,
        backgroundColor: '#000000',
        overflow: 'hidden',
    },
    particle: { position: 'absolute', width: 3, height: 3, borderRadius: 2, backgroundColor: '#ffffff' },
    steps: { position: 'absolute', top: 0, bottom: 0, left: 16, right: 16 },
    step: {
        position: 'absolute',
        top: 0,
        width: 32,
        height: 32,
        marginLeft: -16,
        alignItems: 'center',
        justifyContent: 'center',
    },
    dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: theme.colors.textSecondary },
    passed: { backgroundColor: theme.colors.switch.thumb.active, opacity: 0.35 },
    knobPosition: { position: 'absolute', top: 0, width: 32, height: 32, marginLeft: -16 },
    knob: {
        width: 32,
        height: 32,
        borderRadius: 16,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        backgroundColor: '#ffffff',
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 4,
        elevation: 2,
    },
    models: { flexShrink: 1, minHeight: 0 },
    modelsHead: {
        paddingHorizontal: 10,
        paddingTop: 10,
        paddingBottom: 6,
        flexDirection: 'row',
        alignItems: 'center',
    },
    modelsTitle: { flex: 1, color: theme.colors.text, fontSize: 13, ...Typography.default('semiBold') },
    grow: { flex: 1 },
    selected: { backgroundColor: theme.colors.surfaceSelected },
    optionText: { color: theme.colors.text, fontSize: 13, ...Typography.default('semiBold') },
    search: {
        color: theme.colors.text,
        backgroundColor: theme.colors.surface,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        marginHorizontal: 12,
        marginBottom: 4,
        fontSize: 13,
    },
    description: { color: theme.colors.textSecondary, fontSize: 11, ...Typography.default() },
    modelList: { maxHeight: 300, paddingHorizontal: 7, marginBottom: 8 },
    option: {
        paddingHorizontal: 10,
        paddingVertical: 8,
        minHeight: 38,
        borderRadius: 8,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
}));
