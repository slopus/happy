import React from 'react';
import { View, StyleSheet, ViewStyle } from 'react-native';

interface DividerLineProps {
    indent?: number;
    color?: string;
    style?: ViewStyle;
}

const styles = StyleSheet.create({
    container: {
        flexDirection: 'row',
    },
    divider: {
        flex: 1,
        borderBottomWidth: StyleSheet.hairlineWidth,
    },
});

export function DividerLine({ 
    indent = 0, 
    color = '#E5E5E5',
    style 
}: DividerLineProps) {
    return (
        <View style={[styles.container, style]}>
            {indent > 0 && <View style={{ width: indent }} />}
            <View style={[
                styles.divider,
                { borderBottomColor: color }
            ]} />
        </View>
    );
}