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
    type GestureResponderEvent,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { ModeOption } from '@/components/modelModeOptions';
import { hapticsLight } from '@/components/haptics';
import { ComposerTooltip } from './DesktopShortcutTooltip';

export type SessionComposerModeSelectorConfig = {
    online: boolean;
    unifiedCodex?: boolean;
    model: ModeOption | null;
    modelOptions: ModeOption[];
    effort: ModeOption | null;
    effortOptions: ModeOption[];
    onReset?: () => void;
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

/** Normalize recognizable GPT catalog identifiers without changing provider-specific names. */
export function formatComposerModelName(name: string): string {
    const match = name.trim().match(/^gpt[\s_-]*(\d+(?:\.\d+)?)(?:[\s_-]+([a-z][a-z0-9\s_-]*))?$/i);
    if (!match) {
        return name.replace(/^(opus|sonnet|haiku)(?=\s|$)/i, (value) => value[0].toUpperCase() + value.slice(1).toLowerCase());
    }
    const suffix = match[2] ? ` ${match[2].split(/[\s_-]+/).map((part) => part[0].toUpperCase() + part.slice(1).toLowerCase()).join(' ')}` : '';
    return `GPT-${match[1]}${suffix}`;
}

type ModePanelAnchor = { x: number; y: number; width: number; height: number };
type NativeEffortDrag = { pageX: number; trackPageX: number | null; released: boolean };

export function getModePanelPlacement(width: number, height: number, anchor: ModePanelAnchor | null) {
    const panelWidth = Math.min(292, Math.max(0, width - 24));
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
    const [triggerHovered, setTriggerHovered] = React.useState(false);
    const [modelHovered, setModelHovered] = React.useState(false);
    const [resetHovered, setResetHovered] = React.useState(false);
    const [fastHovered, setFastHovered] = React.useState(false);
    const [knobHovered, setKnobHovered] = React.useState(false);
    const [modelsOpen, setModelsOpen] = React.useState(false);
    const [search, setSearch] = React.useState('');
    const trackRef = React.useRef<View>(null);
    const [trackWidth, setTrackWidth] = React.useState(0);
    const dragIndex = React.useRef<number | null>(null);
    const nativeDrag = React.useRef<NativeEffortDrag | null>(null);
    const [previewFraction, setPreviewFraction] = React.useState<number | null>(null);
    const [pendingEffort, setPendingEffort] = React.useState<string | null>(null);
    const [anchor, setAnchor] = React.useState<ModePanelAnchor | null>(null);
    const enabled =
        props.online &&
        (props.modelOptions.length > 1 ||
            props.effortOptions.length > 1 ||
            (props.supportsFast && !!props.onFastModeChange));
    const close = React.useCallback(() => {
        nativeDrag.current = null;
        dragIndex.current = null;
        setPreviewFraction(null);
        setTriggerHovered(false);
        setModelHovered(false);
        setFastHovered(false);
        setResetHovered(false);
        setKnobHovered(false);
        setOpen(false);
        setModelsOpen(false);
        setSearch('');
    }, []);
    React.useEffect(() => {
        if (!enabled) close();
    }, [enabled, close]);
    const effortKeys = props.effortOptions.map((option) => option.key).join('\0');
    React.useEffect(() => {
        nativeDrag.current = null;
        dragIndex.current = null;
        setPreviewFraction(null);
        setPendingEffort(null);
        setModelHovered(false);
    }, [props.model?.key, effortKeys]);
    React.useEffect(() => () => { nativeDrag.current = null; }, []);
    React.useEffect(() => {
        if (pendingEffort && props.effort?.key === pendingEffort) setPendingEffort(null);
    }, [pendingEffort, props.effort?.key]);
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
        ...option, name: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(option.key.toLowerCase()) ? `${option.key[0].toUpperCase()}${option.key.slice(1).toLowerCase()}` : option.name,
    }));
    const defaultOption = levels.find((option) => option.key === 'medium');
    const defaultModel = props.modelOptions.find(option => /^(?:codex::)?gpt[-_ ]?6\.1[-_ ]sol$/i.test(option.key));
    const reset = () => {
        finishDrag(false);
        if (props.onReset) { props.onReset(); setPendingEffort(null); setPreviewFraction(null); return; }
        if (defaultModel && defaultModel.key !== props.model?.key) props.onModelChange(defaultModel.key);
        if (defaultOption) { setPendingEffort(defaultOption.key); props.onEffortChange(defaultOption.key); }
        if (props.fastMode) props.onFastModeChange?.(false);
    };
    const canReset = Boolean(props.onReset || (defaultModel && defaultOption));
    const effectiveEffort = pendingEffort ? levels.find((level) => level.key === pendingEffort) ?? props.effort : props.effort?.key === 'default' ? defaultOption : levels.find((level) => level.key === props.effort?.key) ?? props.effort;
    const selectedIndex = levels.findIndex((option) => option.key === effectiveEffort?.key);
    const effortIndex = previewFraction === null ? selectedIndex : Math.round(previewFraction * Math.max(0, levels.length - 1));
    const effortFraction = previewFraction ?? (levels.length > 1 && effortIndex >= 0 ? effortIndex / (levels.length - 1) : 0);
    const isUltra = levels[effortIndex]?.key?.toLowerCase() === 'ultra';
    const particleCount = effortFraction > 0 ? Math.round(4 + effortFraction * 18) : 0;
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
    const hoverTransition = Platform.OS === 'web' ? ({ transition: 'background-color 140ms ease, transform 140ms ease' } as any) : undefined;
    const slideTransition = Platform.OS === 'web' && previewFraction === null ? ({ transition: 'left 120ms ease-out, width 120ms ease-out' } as any) : undefined;
    const selectEffortAt = (offsetX: number) => {
        if (trackWidth <= 32 || levels.length === 0) return;
        const fraction = Math.max(0, Math.min(1, (offsetX - 16) / (trackWidth - 32)));
        const index = Math.round(fraction * (levels.length - 1));
        dragIndex.current = index;
        setPreviewFraction(fraction);
    };
    const finishDrag = (commit: boolean) => {
        const option = dragIndex.current === null ? undefined : levels[dragIndex.current];
        nativeDrag.current = null;
        dragIndex.current = null;
        if (commit && option && option.key !== props.effort?.key) {
            setPendingEffort(option.key);
            props.onEffortChange(option.key);
        }
        setPreviewFraction(null);
    };
    const startNativeDrag = (event: GestureResponderEvent) => {
        const drag: NativeEffortDrag = { pageX: event.nativeEvent.pageX, trackPageX: null, released: false };
        nativeDrag.current = drag;
        // locationX is relative to the hit child, not necessarily the track. A moving
        // knob/step changes that origin; measure the track once in page coordinates.
        trackRef.current?.measure((_x, _y, _width, _height, pageX) => {
            if (nativeDrag.current !== drag) return;
            if (!Number.isFinite(pageX)) { finishDrag(false); return; }
            drag.trackPageX = pageX;
            selectEffortAt(drag.pageX - pageX);
            if (drag.released) finishDrag(true);
        });
    };
    const updateNativeDrag = (event: GestureResponderEvent, released = false) => {
        const drag = nativeDrag.current;
        if (!drag || drag.released) return;
        drag.pageX = event.nativeEvent.pageX;
        drag.released = released;
        if (drag.trackPageX === null) return;
        selectEffortAt(drag.pageX - drag.trackPageX);
        if (released) finishDrag(true);
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
                onHoverIn={() => setTriggerHovered(true)}
                onHoverOut={() => setTriggerHovered(false)}
                style={({ pressed }) => [
                    styles.trigger,
                    !enabled && styles.disabled,
                    (open || pressed || triggerHovered) && styles.selected,
                    hoverTransition,
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
                    {open ? t('agentInput.effort.select') : formatComposerModelName(props.model?.name ?? t('agentInput.model.title'))}
                    {!open && effectiveEffort ? <Text style={isUltra ? styles.ultraTitle : styles.triggerEffort}> {effectiveEffort.name}</Text> : null}
                </Text>
                {enabled ? (
                    <Ionicons
                        name={open ? 'chevron-up' : 'chevron-down'}
                        size={11}
                        color={theme.colors.textSecondary}
                    />
                ) : null}
            </Pressable>
            <ComposerTooltip testID="session-composer-mode-tooltip" label={t('agentInput.effort.select')} visible={Platform.OS === 'web' && triggerHovered && !open && Boolean(enabled)} />
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
                                            style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [styles.iconButton, hoverTransition, (pressed || hovered) && styles.pressed]}
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
                                            style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [styles.iconButton, hoverTransition, (pressed || hovered) && styles.pressed]}
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
                                                `${option.name} ${formatComposerModelName(option.name)} ${option.description ?? ''}`
                                                    .toLocaleLowerCase()
                                                    .includes(search.trim().toLocaleLowerCase()),
                                            )
                                            .map((option) => (
                                                <Pressable
                                                    key={option.key}
                                                    testID={`session-composer-model-${option.key}`}
                                                    {...spaceActivation(() => {
                                                        props.onModelChange(option.key);
                                                        setModelHovered(false);
                                                        setModelsOpen(false);
                                                        setSearch('');
                                                    })}
                                                    accessibilityRole="radio"
                                                    accessibilityLabel={
                                                        option.description
                                                            ? `${formatComposerModelName(option.name)}, ${option.description}`
                                                            : formatComposerModelName(option.name)
                                                    }
                                                    accessibilityState={{
                                                        checked: props.model?.key === option.key,
                                                    }}
                                                    aria-checked={props.model?.key === option.key}
                                                    onPress={() => {
                                                        props.onModelChange(option.key);
                                                        setModelHovered(false);
                                                        setModelsOpen(false);
                                                        setSearch('');
                                                    }}
                                                    style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
                                                        styles.option, hoverTransition,
                                                        (pressed || hovered) && styles.pressed,
                                                    ]}
                                                >
                                                    <View style={styles.grow}>
                                                        <Text style={styles.optionText}>{formatComposerModelName(option.name)}</Text>
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
                                                onHoverIn={() => setFastHovered(true)}
                                                onHoverOut={() => setFastHovered(false)}
                                                style={[styles.iconButton, hoverTransition, fastHovered && styles.pressed]}
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
                                                <ComposerTooltip testID="composer-fast-tooltip" label={props.fastMode ? t('agentInput.effort.fastOn') : t('agentInput.effort.fastOff')} visible={Platform.OS === 'web' && fastHovered && !!props.supportsFast} />
                                            </Pressable>
                                        ) : (
                                            <View style={styles.iconButton} />
                                        )}
                                        <View style={styles.centerSlot}>
                                        <Pressable
                                            testID="session-composer-open-models"
                                            accessibilityLabel={t('agentInput.model.title')}
                                            accessibilityRole="button"
                                            accessibilityState={{ disabled: props.modelOptions.length < 2 }}
                                            disabled={props.modelOptions.length < 2}
                                            onPress={() => { finishDrag(false); setModelHovered(false); setModelsOpen(true); }}
                                            onHoverIn={() => setModelHovered(true)}
                                            onHoverOut={() => setModelHovered(false)}
                                            style={({ pressed }) => [styles.center, hoverTransition, (pressed || modelHovered) && styles.centerHover]}
                                        >
                                            {effectiveEffort ? (
                                                <Text style={[styles.levelTitle, isUltra && styles.ultraTitle]}>
                                                    {previewFraction === null ? effectiveEffort.name : levels[effortIndex]?.name}
                                                </Text>
                                            ) : null}
                                            <Text style={styles.modelLink} numberOfLines={1}>
                                                {formatComposerModelName(props.model?.name ?? t('agentInput.model.title'))}
                                                {props.modelOptions.length > 1 ? '  ›' : ''}
                                            </Text>
                                            <ComposerTooltip testID="composer-model-list-tooltip" label={t('agentInput.model.title')} visible={Platform.OS === 'web' && modelHovered && props.modelOptions.length > 1} />
                                        </Pressable>
                                        </View>
                                        <Pressable
                                            testID="session-composer-effort-reset"
                                            accessibilityRole="button"
                                            accessibilityLabel={t('common.reset')}
                                            accessibilityState={{ disabled: !canReset }}
                                            disabled={!canReset}
                                            accessibilityHint={canReset ? defaultOption?.name : t('settingsAccount.notAvailable')}
                                            onPress={reset}
                                            onHoverIn={() => setResetHovered(true)}
                                            onHoverOut={() => setResetHovered(false)}
                                            style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [styles.iconButton, hoverTransition, !canReset && styles.disabled, canReset && (pressed || hovered) && styles.pressed]}
                                        >
                                            <Ionicons
                                                name="refresh-outline"
                                                size={20}
                                                color={theme.colors.textSecondary}
                                            />
                                            <ComposerTooltip testID="composer-reset-tooltip" label={t('common.reset')} visible={Platform.OS === 'web' && resetHovered && canReset} />
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
                                                          const offset = event.clientX - event.currentTarget.getBoundingClientRect().left;
                                                          if (dragIndex.current !== null) selectEffortAt(offset);
                                                          else setKnobHovered(Math.abs(offset - (16 + Math.max(0, trackWidth - 32) * effortFraction)) <= 20);
                                                      },
                                                      onPointerLeave: () => setKnobHovered(false),
                                                      onPointerUp: () => finishDrag(true),
                                                      onPointerCancel: () => finishDrag(false),
                                                  }
                                                : {
                                                      onStartShouldSetResponderCapture: () => true,
                                                      onStartShouldSetResponder: () => true,
                                                      onResponderGrant: startNativeDrag,
                                                      onResponderMove: (event: GestureResponderEvent) => updateNativeDrag(event),
                                                      onResponderRelease: (event: GestureResponderEvent) => updateNativeDrag(event, true),
                                                      onResponderTerminate: () => finishDrag(false),
                                                  })}
                                        >
                                            {effortFraction > 0 ? (
                                                <View pointerEvents="none" style={[styles.fill, slideTransition, {
                                                    width: Platform.OS === 'web'
                                                        ? `calc(${effortFraction * 100}% + ${16 - 32 * effortFraction}px)` as any
                                                        : 16 + Math.max(0, trackWidth - 32) * effortFraction,
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
                                                                        position: 'absolute', width: '100%', height: 3,
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
                                                        {...spaceActivation(() => {
                                                            setPendingEffort(option.key);
                                                            props.onEffortChange(option.key);
                                                        })}
                                                        accessibilityRole="radio"
                                                        accessibilityLabel={option.name}
                                                        aria-checked={effectiveEffort?.key === option.key}
                                                        accessibilityState={{
                                                            checked: effectiveEffort?.key === option.key,
                                                        }}
                                                        onPress={(event) => {
                                                            if (Platform.OS !== 'web' || !event?.nativeEvent || (event.nativeEvent as any).detail === 0) {
                                                                setPendingEffort(option.key);
                                                                props.onEffortChange(option.key);
                                                            }
                                                        }}
                                                        style={[
                                                            styles.step,
                                                            {
                                                                left: `${levels.length > 1 ? (index * 100) / (levels.length - 1) : 0}%`,
                                                            },
                                                        ]}
                                                    >
                                                        {index > effortIndex ? <View style={styles.dot} /> : null}
                                                    </Pressable>
                                                ))}
                                                {effortIndex >= 0 ? (
                                                    <View pointerEvents="none" testID="session-composer-effort-knob" style={[styles.knobPosition, slideTransition, {
                                                        left: `${effortFraction * 100}%`,
                                                    }]}><View style={[styles.knob, hoverTransition, (knobHovered || previewFraction !== null) && styles.knobHover]} /></View>
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
    pressed: { backgroundColor: theme.colors.surfaceSelected },
    modalRoot: { flex: 1 },
    backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    panel: {
        borderRadius: 18,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.input.background,
        overflow: Platform.OS === 'web' ? 'visible' : 'hidden',
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 16,
        elevation: 8,
    },
    settings: { paddingHorizontal: 14, paddingTop: 12, paddingBottom: 14 },
    panelHead: { flexDirection: 'row', alignItems: 'flex-start' },
    iconButton: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
    centerSlot: { flex: 1, alignItems: 'center', minWidth: 0 },
    center: { alignItems: 'center', maxWidth: '100%', borderRadius: 10, paddingVertical: 4, paddingHorizontal: 12 },
    centerHover: { backgroundColor: theme.colors.surfaceSelected, shadowColor: theme.colors.shadow.color, shadowOffset: { width: 0, height: 2 }, shadowOpacity: theme.colors.shadow.opacity, shadowRadius: 6, elevation: 2 },
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
        marginTop: 12,
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
    knobHover: { transform: [{ scale: 1.06 }] },
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
