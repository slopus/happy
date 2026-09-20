import * as React from 'react';
import { StyleSheet, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Host, Picker, Text } from '@expo/ui/swift-ui';
import { accessibilityLabel, frame, pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';
import {
    NATIVE_SEGMENTED_CONTROL_HEIGHT,
    type NativeSegmentedControlProps,
} from './nativeSegmentedControlShared';

export type { NativeSegmentedControlOption, NativeSegmentedControlProps } from './nativeSegmentedControlShared';

const styles = StyleSheet.create({
    container: {
        width: '100%',
        height: NATIVE_SEGMENTED_CONTROL_HEIGHT,
    },
    host: {
        ...StyleSheet.absoluteFillObject,
    },
});

/**
 * The system's segmented picker, hosted in SwiftUI so it looks and moves the
 * way every other segmented control on the phone does.
 */
export function NativeSegmentedControl({
    options,
    selectedKey,
    onSelect,
    accessibilityLabel: label,
}: NativeSegmentedControlProps) {
    const { theme } = useUnistyles();
    return (
        <View style={styles.container}>
            {/* The host must not perform keyboard avoidance: the keyboard is up
                for the whole of the composer's life and this sits above it. */}
            <Host
                // SwiftUI hosts keep the old tint when the app theme flips at
                // runtime, so the host is remounted with the theme.
                key={theme.dark ? 'dark' : 'light'}
                ignoreSafeArea="keyboard"
                style={styles.host}
            >
                <Picker
                    selection={selectedKey}
                    onSelectionChange={(selection) => {
                        if (typeof selection === 'string') onSelect(selection);
                    }}
                    modifiers={[
                        pickerStyle('segmented'),
                        frame({ maxWidth: 10000, height: NATIVE_SEGMENTED_CONTROL_HEIGHT }),
                        accessibilityLabel(label),
                    ]}
                >
                    {options.map((option) => (
                        <Text key={option.key} modifiers={[tag(option.key)]}>{option.label}</Text>
                    ))}
                </Picker>
            </Host>
        </View>
    );
}
