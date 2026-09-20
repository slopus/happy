import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

import {
    NATIVE_SEGMENTED_CONTROL_HEIGHT,
    type NativeSegmentedControlProps,
} from './nativeSegmentedControlShared';

export type { NativeSegmentedControlOption, NativeSegmentedControlProps } from './nativeSegmentedControlShared';

const styles = StyleSheet.create((theme) => ({
    track: {
        height: NATIVE_SEGMENTED_CONTROL_HEIGHT,
        flexDirection: 'row',
        padding: 2,
        borderRadius: 9,
        backgroundColor: theme.colors.glass.backgroundSubtle,
    },
    segment: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 7,
    },
    segmentSelected: {
        backgroundColor: theme.colors.surfaceHighest,
    },
    label: {
        color: theme.colors.textSecondary,
        fontSize: 13,
        ...Typography.default('semiBold'),
    },
    labelSelected: {
        color: theme.colors.text,
    },
}));

/**
 * A segmented control drawn by React Native. iOS draws the system's own
 * segmented picker instead (see the `.ios` file); this is what Android and web
 * get, styled to sit on the same glass as the rows around it.
 */
export function NativeSegmentedControl({
    options,
    selectedKey,
    onSelect,
    accessibilityLabel,
}: NativeSegmentedControlProps) {
    return (
        <View style={styles.track} accessibilityRole="tablist" accessibilityLabel={accessibilityLabel}>
            {options.map((option) => {
                const selected = option.key === selectedKey;
                return (
                    <Pressable
                        key={option.key}
                        onPress={() => onSelect(option.key)}
                        style={[styles.segment, selected && styles.segmentSelected]}
                        accessibilityRole="tab"
                        accessibilityState={{ selected }}
                    >
                        <Text style={[styles.label, selected && styles.labelSelected]} numberOfLines={1}>
                            {option.label}
                        </Text>
                    </Pressable>
                );
            })}
        </View>
    );
}
