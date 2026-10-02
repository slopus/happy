import * as React from 'react';
import { Modal as RNModal, Pressable, ScrollView, Text, View, useWindowDimensions, type StyleProp, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/** The sheet never covers more of the window than this, so the scrim stays tappable. */
const MAX_HEIGHT_FRACTION = 0.7;
/** Android's minimum touch target. */
const TOUCH_TARGET = 48;
const RADIO_SIZE = 20;
const ROW_INSET = 24;
const RADIO_GAP = 16;

/** Android's pressed state is a ripple; the theme's pressed overlay is transparent there. */
function rippleColor(dark: boolean): string {
    return dark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.10)';
}

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        justifyContent: 'flex-end',
    },
    scrim: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(0, 0, 0, 0.32)',
    },
    // Opaque on purpose: a translucent surface over the conversation or the
    // dimmed dock washed the rows out on Android, which has no backdrop blur.
    panel: {
        width: '100%',
        maxWidth: 640,
        alignSelf: 'center',
        backgroundColor: theme.colors.surface,
        borderRadius: 28,
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        elevation: 6,
    },
    panelAttached: {
        borderBottomLeftRadius: 0,
        borderBottomRightRadius: 0,
        borderBottomWidth: 0,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: ROW_INSET,
        paddingRight: 4,
        paddingTop: 4,
        minHeight: TOUCH_TARGET + 8,
    },
    title: {
        flex: 1,
        minWidth: 0,
        fontSize: 17,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    close: {
        width: TOUCH_TARGET,
        height: TOUCH_TARGET,
        borderRadius: TOUCH_TARGET / 2,
        alignItems: 'center',
        justifyContent: 'center',
    },
    pressed: {
        backgroundColor: theme.colors.surfacePressedOverlay,
    },
    // Shrinks to the space the panel has left, so a long list scrolls inside
    // the panel instead of running past its edge.
    list: {
        flexGrow: 0,
        flexShrink: 1,
    },
    listContent: {
        paddingBottom: 8,
    },
    sectionHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: ROW_INSET,
        paddingTop: 12,
        paddingBottom: 4,
    },
    sectionTitle: {
        flexShrink: 1,
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    sectionSeparator: {
        height: StyleSheet.hairlineWidth,
        marginHorizontal: ROW_INSET,
        marginTop: 8,
        backgroundColor: theme.colors.divider,
    },
    option: {
        minHeight: 56,
        flexDirection: 'row',
        alignItems: 'center',
        gap: RADIO_GAP,
        paddingHorizontal: ROW_INSET,
        paddingVertical: 8,
    },
    optionDisabled: {
        opacity: 0.45,
    },
    radio: {
        width: RADIO_SIZE,
        height: RADIO_SIZE,
        borderRadius: RADIO_SIZE / 2,
        borderWidth: 2,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    radioDot: {
        width: 10,
        height: 10,
        borderRadius: 5,
    },
    actionIcon: {
        width: RADIO_SIZE,
        alignItems: 'center',
        flexShrink: 0,
    },
    optionCopy: {
        flex: 1,
        minWidth: 0,
    },
    optionLabelRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    optionLabel: {
        flexShrink: 1,
        fontSize: 16,
        color: theme.colors.text,
        ...Typography.default(),
    },
    optionDescription: {
        marginTop: 2,
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
}));

/**
 * The surface of a single-choice picker: its title, a 48dp close button, and
 * a list that scrolls within the panel's height. Rendered by `PickerSheet`
 * as a modal bottom sheet, or inline by a screen that is already a modal and
 * must keep its keyboard.
 */
export function PickerSheetPanel(props: {
    title: string;
    onClose: () => void;
    children: React.ReactNode;
    /** Square bottom corners for a sheet that meets the screen's bottom edge. */
    attached?: boolean;
    style?: StyleProp<ViewStyle> | React.ComponentProps<typeof Animated.View>['style'];
}) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    return (
        <Animated.View
            style={[styles.panel, props.attached && styles.panelAttached, props.style as StyleProp<ViewStyle>]}
            accessibilityViewIsModal
        >
            <View style={styles.header}>
                <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
                    {props.title}
                </Text>
                <Pressable
                    onPress={props.onClose}
                    android_ripple={{ color: rippleColor(theme.dark), borderless: true, radius: TOUCH_TARGET / 2 }}
                    style={({ pressed }) => [styles.close, pressed && styles.pressed]}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.cancel')}
                >
                    <Ionicons name="close" size={22} color={theme.colors.text} />
                </Pressable>
            </View>
            <ScrollView
                style={styles.list}
                contentContainerStyle={styles.listContent}
                keyboardShouldPersistTaps="handled"
            >
                {props.children}
            </ScrollView>
        </Animated.View>
    );
}

/**
 * A modal bottom sheet for picking one value. It is a full-window modal, not a
 * child of the control that opened it: an overlay drawn inside the composer is
 * clipped to the composer's bounds on Android, so its list could not scroll and
 * taps outside it never landed. The scrim, Back, and the close button all
 * dismiss without choosing anything.
 */
export function PickerSheet(props: {
    visible: boolean;
    title: string;
    onClose: () => void;
    children: React.ReactNode;
}) {
    const styles = stylesheet;
    const insets = useSafeAreaInsets();
    const { height } = useWindowDimensions();
    return (
        <RNModal
            visible={props.visible}
            transparent
            animationType="fade"
            statusBarTranslucent
            navigationBarTranslucent
            onRequestClose={props.onClose}
        >
            <View style={styles.root}>
                <Pressable
                    style={styles.scrim}
                    onPress={props.onClose}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.cancel')}
                />
                <PickerSheetPanel
                    attached
                    title={props.title}
                    onClose={props.onClose}
                    style={{ maxHeight: height * MAX_HEIGHT_FRACTION, paddingBottom: insets.bottom }}
                >
                    {props.children}
                </PickerSheetPanel>
            </View>
        </RNModal>
    );
}

/** A group heading inside a picker, such as a provider with its icon. */
export function PickerSheetSection(props: {
    title?: string | null;
    icon?: React.ReactNode;
    /** Draws a rule above the group; every group after the first has one. */
    separated?: boolean;
}) {
    const styles = stylesheet;
    return (
        <>
            {props.separated ? <View style={styles.sectionSeparator} /> : null}
            {props.title ? (
                <View style={styles.sectionHeader} accessibilityRole="header">
                    {props.icon}
                    <Text style={styles.sectionTitle} numberOfLines={1}>{props.title}</Text>
                </View>
            ) : null}
        </>
    );
}

/**
 * One single-choice row: a radio, the label, and an optional second line.
 * The whole row is the target. An `action` row (such as "Enter custom
 * path…") is never drawn as a choice.
 */
export function PickerSheetOption(props: {
    label: string;
    description?: string | null;
    selected: boolean;
    disabled?: boolean;
    action?: boolean;
    /** A small glyph before the label, such as a permission mode's kind. */
    labelIcon?: React.ReactNode;
    onPress: () => void;
}) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const label = props.description ? `${props.label}, ${props.description}` : props.label;
    return (
        <Pressable
            disabled={props.disabled}
            onPress={props.onPress}
            android_ripple={{ color: rippleColor(theme.dark) }}
            style={({ pressed }) => [
                styles.option,
                pressed && styles.pressed,
                props.disabled && styles.optionDisabled,
            ]}
            accessibilityRole={props.action ? 'button' : 'radio'}
            accessibilityState={props.action
                ? { disabled: !!props.disabled }
                : { checked: props.selected, disabled: !!props.disabled }}
            accessibilityLabel={label}
        >
            {props.action ? (
                <View style={styles.actionIcon}>
                    <Ionicons name="add" size={RADIO_SIZE} color={theme.colors.textSecondary} />
                </View>
            ) : (
                <View style={[styles.radio, { borderColor: props.selected ? theme.colors.radio.active : theme.colors.radio.inactive }]}>
                    {props.selected ? (
                        <View style={[styles.radioDot, { backgroundColor: theme.colors.radio.dot }]} />
                    ) : null}
                </View>
            )}
            <View style={styles.optionCopy}>
                {props.labelIcon ? (
                    <View style={styles.optionLabelRow}>
                        {props.labelIcon}
                        <Text style={styles.optionLabel} numberOfLines={1}>{props.label}</Text>
                    </View>
                ) : (
                    <Text style={styles.optionLabel} numberOfLines={1}>{props.label}</Text>
                )}
                {props.description ? (
                    <Text style={styles.optionDescription} numberOfLines={2}>{props.description}</Text>
                ) : null}
            </View>
        </Pressable>
    );
}
