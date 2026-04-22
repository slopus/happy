/**
 * TurnPicker — floating overlay for jumping to a specific turn by
 * number input or by tapping an item in the scrollable turn list.
 */

import * as React from 'react';
import { FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { TurnInfo } from '@/hooks/useTurnIndices';

interface TurnPickerProps {
    turns: TurnInfo[];
    currentTurnNumber: number | null;
    onSelect: (turnNumber: number) => void;
    onClose: () => void;
}

export const TurnPicker = React.memo((props: TurnPickerProps) => {
    const { theme } = useUnistyles();
    const [inputValue, setInputValue] = React.useState(
        props.currentTurnNumber !== null ? String(props.currentTurnNumber) : '',
    );
    const inputRef = React.useRef<TextInput>(null);

    // Auto-focus input on mount
    React.useEffect(() => {
        setTimeout(() => inputRef.current?.focus(), 100);
    }, []);

    // Reverse turns for display: oldest (turn 1) at top, newest at bottom
    const reversedTurns = React.useMemo(
        () => [...props.turns].reverse(),
        [props.turns],
    );

    const handleSubmit = React.useCallback(() => {
        const num = parseInt(inputValue, 10);
        if (num >= 1 && num <= props.turns.length) {
            props.onSelect(num);
        }
    }, [inputValue, props.turns.length, props.onSelect]);

    const handleItemPress = React.useCallback((turnNumber: number) => {
        props.onSelect(turnNumber);
    }, [props.onSelect]);

    // Turns sorted newest-first for display (same order as turns array)
    const renderItem = React.useCallback(({ item }: { item: TurnInfo }) => (
        <Pressable
            onPress={() => handleItemPress(item.turnNumber)}
            style={({ pressed }) => [
                styles.listItem,
                item.turnNumber === props.currentTurnNumber && styles.listItemActive,
                pressed && styles.listItemPressed,
            ]}
        >
            <Text style={[styles.listItemNumber, { color: theme.colors.textSecondary }]}>
                {item.turnNumber}
            </Text>
            <Text
                style={[styles.listItemText, { color: theme.colors.text }]}
                numberOfLines={1}
            >
                {item.preview || '...'}
            </Text>
        </Pressable>
    ), [handleItemPress, props.currentTurnNumber, theme]);

    return (
        <>
            {/* Backdrop */}
            <Pressable style={styles.backdrop} onPress={props.onClose} />

            {/* Picker panel */}
            <View style={styles.panel}>
                {/* Input row */}
                <View style={styles.inputRow}>
                    <Text style={[styles.inputLabel, { color: theme.colors.textSecondary }]}>
                        Go to:
                    </Text>
                    <TextInput
                        ref={inputRef}
                        style={[styles.input, {
                            color: theme.colors.text,
                            borderColor: theme.colors.divider,
                        }]}
                        value={inputValue}
                        onChangeText={setInputValue}
                        onSubmitEditing={handleSubmit}
                        keyboardType="number-pad"
                        returnKeyType="go"
                        selectTextOnFocus
                        placeholder={`1-${props.turns.length}`}
                        placeholderTextColor={theme.colors.textSecondary}
                    />
                    <Text style={[styles.inputTotal, { color: theme.colors.textSecondary }]}>
                        / {props.turns.length}
                    </Text>
                </View>

                {/* Divider */}
                <View style={[styles.divider, { backgroundColor: theme.colors.divider }]} />

                {/* Turn list — display oldest first (natural reading order) */}
                <FlatList
                    data={reversedTurns}
                    keyExtractor={(item) => String(item.turnNumber)}
                    renderItem={renderItem}
                    style={styles.list}
                    keyboardShouldPersistTaps="handled"
                    initialScrollIndex={
                        props.currentTurnNumber !== null
                            ? reversedTurns.findIndex(t => t.turnNumber === props.currentTurnNumber)
                            : reversedTurns.length - 1
                    }
                    getItemLayout={(_, index) => ({
                        length: ITEM_HEIGHT,
                        offset: ITEM_HEIGHT * index,
                        index,
                    })}
                />
            </View>
        </>
    );
});

const ITEM_HEIGHT = 44;

const styles = StyleSheet.create((theme) => ({
    backdrop: {
        position: 'absolute',
        top: -2000,
        left: -2000,
        right: -2000,
        bottom: -2000,
        zIndex: 999,
    },
    panel: {
        position: 'absolute',
        right: 50,
        bottom: 80,
        width: 280,
        maxHeight: 360,
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 4 },
        shadowRadius: 8,
        shadowOpacity: theme.colors.shadow.opacity,
        elevation: 8,
        zIndex: 1000,
        overflow: 'hidden',
    },
    inputRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 10,
        gap: 8,
    },
    inputLabel: {
        fontSize: 13,
        fontWeight: '600',
    },
    input: {
        width: 56,
        height: 32,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 8,
        fontSize: 14,
        textAlign: 'center',
        fontVariant: ['tabular-nums'],
    },
    inputTotal: {
        fontSize: 13,
        fontVariant: ['tabular-nums'],
    },
    divider: {
        height: 1,
    },
    list: {
        maxHeight: 300,
    },
    listItem: {
        flexDirection: 'row',
        alignItems: 'center',
        height: ITEM_HEIGHT,
        paddingHorizontal: 12,
        gap: 10,
    },
    listItemActive: {
        backgroundColor: theme.colors.surfacePressed,
    },
    listItemPressed: {
        opacity: 0.7,
    },
    listItemNumber: {
        width: 32,
        fontSize: 13,
        fontWeight: '600',
        textAlign: 'right',
        fontVariant: ['tabular-nums'],
    },
    listItemText: {
        flex: 1,
        fontSize: 13,
    },
}));
