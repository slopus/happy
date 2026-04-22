import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { TurnPicker } from './TurnPicker';
import { TurnInfo } from '@/hooks/useTurnIndices';
import { TURN_NAVIGATION_SHORTCUTS } from '@/hooks/turnNavigationKeyboard';

interface TurnNavigatorProps {
    currentTurnNumber: number | null;
    totalTurns: number;
    turns: TurnInfo[];
    onPrev: () => void;
    onNext: () => void;
    onPrevPage: () => void;
    onNextPage: () => void;
    onEnd: () => void;
    onGoToTurn: (turnNumber: number) => void;
    hasPrev: boolean;
    hasNext: boolean;
}

export const TurnNavigator = React.memo((props: TurnNavigatorProps) => {
    const { theme } = useUnistyles();
    const [pickerOpen, setPickerOpen] = React.useState(false);
    const [hoveredTooltip, setHoveredTooltip] = React.useState<string | null>(null);

    if (props.totalTurns <= 1) return null;

    const label = props.currentTurnNumber !== null
        ? `${props.currentTurnNumber}/${props.totalTurns}`
        : `${props.totalTurns}`;

    const iconColor = theme.colors.fab.icon;

    const handleLabelPress = () => setPickerOpen(true);

    const handlePickerSelect = (turnNumber: number) => {
        setPickerOpen(false);
        props.onGoToTurn(turnNumber);
    };

    return (
        <View style={styles.container}>
            {/* Skip 5 turns older — rotated skip icon */}
            <NavButton
                icon="play-skip-back"
                onPress={props.onPrevPage}
                disabled={!props.hasPrev}
                color={iconColor}
                rotate="90deg"
                tooltip={TURN_NAVIGATION_SHORTCUTS.prevPage}
                onHoverChange={setHoveredTooltip}
            />

            {/* 1 turn older */}
            <NavButton
                icon="chevron-up"
                onPress={props.onPrev}
                disabled={!props.hasPrev}
                color={iconColor}
                tooltip={TURN_NAVIGATION_SHORTCUTS.prev}
                onHoverChange={setHoveredTooltip}
            />

            {/* Tappable turn counter — opens picker */}
            <Pressable
                onPress={handleLabelPress}
                hitSlop={8}
                accessibilityLabel={TURN_NAVIGATION_SHORTCUTS.picker}
                onHoverIn={() => setHoveredTooltip(TURN_NAVIGATION_SHORTCUTS.picker)}
                onHoverOut={() => setHoveredTooltip((current) => current === TURN_NAVIGATION_SHORTCUTS.picker ? null : current)}
            >
                <Text style={[styles.label, { color: iconColor }]}>
                    {label}
                </Text>
            </Pressable>

            {/* 1 turn newer */}
            <NavButton
                icon="chevron-down"
                onPress={props.onNext}
                disabled={!props.hasNext}
                color={iconColor}
                tooltip={TURN_NAVIGATION_SHORTCUTS.next}
                onHoverChange={setHoveredTooltip}
            />

            {/* Skip 5 turns newer — rotated skip icon */}
            <NavButton
                icon="play-skip-forward"
                onPress={props.onNextPage}
                disabled={!props.hasNext}
                color={iconColor}
                rotate="90deg"
                tooltip={TURN_NAVIGATION_SHORTCUTS.nextPage}
                onHoverChange={setHoveredTooltip}
            />

            {/* Jump to latest — always visible */}
            <NavButton
                icon="chevron-down-circle-outline"
                onPress={props.onEnd}
                disabled={false}
                color={iconColor}
                tooltip={TURN_NAVIGATION_SHORTCUTS.end}
                onHoverChange={setHoveredTooltip}
            />

            {hoveredTooltip && (
                <View
                    pointerEvents="none"
                    style={[
                        styles.tooltip,
                        {
                            backgroundColor: theme.colors.header.background,
                            borderColor: theme.colors.divider,
                        },
                    ]}
                >
                    <Text style={[styles.tooltipText, { color: theme.colors.text }]}>
                        {hoveredTooltip}
                    </Text>
                </View>
            )}

            {/* Turn picker overlay */}
            {pickerOpen && (
                <TurnPicker
                    turns={props.turns}
                    currentTurnNumber={props.currentTurnNumber}
                    onSelect={handlePickerSelect}
                    onClose={() => setPickerOpen(false)}
                />
            )}
        </View>
    );
});

const NavButton = React.memo((props: {
    icon: keyof typeof Ionicons.glyphMap;
    onPress: () => void;
    disabled: boolean;
    color: string;
    rotate?: string;
    tooltip: string;
    onHoverChange: (tooltip: string | null) => void;
}) => (
    <Pressable
        onPress={props.onPress}
        disabled={props.disabled}
        accessibilityLabel={props.tooltip}
        onHoverIn={() => props.onHoverChange(props.tooltip)}
        onHoverOut={() => props.onHoverChange(null)}
        style={({ pressed }) => [
            styles.button,
            props.disabled && styles.disabled,
            pressed && !props.disabled && styles.pressed,
        ]}
    >
        <Ionicons
            name={props.icon}
            size={18}
            color={props.color}
            style={props.rotate ? { transform: [{ rotate: props.rotate }] } : undefined}
        />
    </Pressable>
));

/** Two chevrons stacked tightly — used for skip-5 navigation */
const DoubleNavButton = React.memo((props: {
    icon: keyof typeof Ionicons.glyphMap;
    onPress: () => void;
    disabled: boolean;
    color: string;
}) => (
    <Pressable
        onPress={props.onPress}
        disabled={props.disabled}
        style={({ pressed }) => [
            styles.button,
            props.disabled && styles.disabled,
            pressed && !props.disabled && styles.pressed,
        ]}
    >
        <View style={styles.doubleChevron}>
            <Ionicons name={props.icon} size={14} color={props.color} />
            <Ionicons name={props.icon} size={14} color={props.color} style={styles.doubleChevronSecond} />
        </View>
    </Pressable>
));

const styles = StyleSheet.create((theme) => ({
    container: {
        position: 'absolute',
        right: 12,
        bottom: 80,
        alignItems: 'center',
        backgroundColor: theme.colors.fab.background,
        borderRadius: 20,
        paddingVertical: 4,
        paddingHorizontal: 6,
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 2 },
        shadowRadius: 4,
        shadowOpacity: theme.colors.shadow.opacity,
        elevation: 4,
    },
    tooltip: {
        position: 'absolute',
        right: '100%',
        top: '50%',
        transform: [{ translateY: -16 }],
        marginRight: 10,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 8,
        borderWidth: StyleSheet.hairlineWidth,
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 2 },
        shadowRadius: 6,
        shadowOpacity: theme.colors.shadow.opacity,
        elevation: 6,
    },
    tooltipText: {
        fontSize: 12,
        fontVariant: ['tabular-nums'],
    },
    button: {
        padding: 6,
    },
    disabled: {
        opacity: 0.3,
    },
    pressed: {
        opacity: 0.6,
    },
    label: {
        fontSize: 11,
        fontVariant: ['tabular-nums'],
        textDecorationLine: 'underline',
    },
    doubleChevron: {
        alignItems: 'center',
    },
    doubleChevronSecond: {
        marginTop: -8,
    },
}));
