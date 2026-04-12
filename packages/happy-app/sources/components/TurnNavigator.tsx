import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { TurnPicker } from './TurnPicker';
import { TurnInfo } from '@/hooks/useTurnIndices';

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
            />

            {/* 1 turn older */}
            <NavButton
                icon="chevron-up"
                onPress={props.onPrev}
                disabled={!props.hasPrev}
                color={iconColor}
            />

            {/* Tappable turn counter — opens picker */}
            <Pressable onPress={handleLabelPress} hitSlop={8}>
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
            />

            {/* Skip 5 turns newer — rotated skip icon */}
            <NavButton
                icon="play-skip-forward"
                onPress={props.onNextPage}
                disabled={!props.hasNext}
                color={iconColor}
                rotate="90deg"
            />

            {/* Jump to latest — always visible */}
            <NavButton
                icon="chevron-down-circle-outline"
                onPress={props.onEnd}
                disabled={false}
                color={iconColor}
            />

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
