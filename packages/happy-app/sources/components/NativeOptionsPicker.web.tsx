import * as React from 'react';
import { Picker } from '@react-native-picker/picker';
import { StyleSheet, View } from 'react-native';
import type { NativeOptionsPickerProps } from './NativeOptionsPicker';

const styles = StyleSheet.create({
    container: {
        position: 'relative',
        width: '100%',
    },
    picker: {
        ...StyleSheet.absoluteFillObject,
        opacity: 0,
    },
});

export function NativeOptionsPicker({
    title,
    options,
    selectedKey,
    onSelect,
    children,
}: NativeOptionsPickerProps) {
    return (
        <View style={styles.container}>
            <View pointerEvents="none">{children}</View>
            <Picker
                selectedValue={selectedKey ?? undefined}
                onValueChange={(value) => {
                    if (typeof value === 'string' && value !== selectedKey) onSelect(value);
                }}
                prompt={title}
                style={styles.picker}
            >
                {options.map((option) => (
                    <Picker.Item key={option.key} label={option.label} value={option.key} />
                ))}
            </Picker>
        </View>
    );
}
