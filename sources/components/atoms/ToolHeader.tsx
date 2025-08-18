import React from 'react';
import { View, StyleSheet, ViewStyle } from 'react-native';
import { Text } from '../StyledText';
import { StatusBadge, ToolState } from './StatusBadge';

interface ToolHeaderProps {
    icon?: string;
    title: string;
    state: ToolState;
    style?: ViewStyle;
}

export function ToolHeader({ 
    icon, 
    title, 
    state,
    style 
}: ToolHeaderProps) {
    return (
        <View style={[styles.container, style]}>
            <Text style={styles.title}>
                {icon && `${icon} `}{title}
            </Text>
            <StatusBadge state={state} />
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 16,
    },
    title: {
        fontSize: 18,
        fontWeight: '600',
        color: '#111827',
    },
});