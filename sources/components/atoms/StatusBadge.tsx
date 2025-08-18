import React from 'react';
import { View, StyleSheet, ViewStyle } from 'react-native';
import { Text } from '../StyledText';

export type ToolState = 'running' | 'completed' | 'error' | 'pending';

interface StatusBadgeProps {
    state: ToolState;
    style?: ViewStyle;
}

const STATUS_CONFIG = {
    running: {
        icon: '⏳',
        text: 'Running',
        backgroundColor: '#FFF3E0',
        borderColor: '#F57C00',
        textColor: '#F57C00'
    },
    completed: {
        icon: '✅',
        text: 'Completed',
        backgroundColor: '#E8F5E8',
        borderColor: '#2E7D32',
        textColor: '#2E7D32'
    },
    error: {
        icon: '❌',
        text: 'Error',
        backgroundColor: '#FFEBEE',
        borderColor: '#D32F2F',
        textColor: '#D32F2F'
    },
    pending: {
        icon: '⏸️',
        text: 'Pending',
        backgroundColor: '#F5F5F5',
        borderColor: '#E0E0E0',
        textColor: '#666666'
    }
};

const styles = StyleSheet.create({
    badge: {
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 12,
        borderWidth: 1,
    },
    text: {
        fontSize: 14,
        fontWeight: '500',
    },
});

export function StatusBadge({ state, style }: StatusBadgeProps) {
    const config = STATUS_CONFIG[state];
    
    return (
        <View style={[
            styles.badge,
            {
                backgroundColor: config.backgroundColor,
                borderColor: config.borderColor,
            },
            style
        ]}>
            <Text style={[
                styles.text,
                { color: config.textColor }
            ]}>
                {config.icon} {config.text}
            </Text>
        </View>
    );
}

// Helper function to get just the status text with icon
export function getStatusDisplay(state: string): string {
    switch (state) {
        case 'running': return '⏳ Running';
        case 'completed': return '✅ Complete';
        case 'error': return '❌ Error';
        case 'pending': return '⏸️ Pending';
        default: return state;
    }
}

// Helper function to get the color for status text
export function getStatusColor(state: string): string {
    switch (state) {
        case 'running': return '#F57C00';
        case 'completed': return '#2E7D32';
        case 'error': return '#D32F2F';
        case 'pending': return '#666666';
        default: return '#666666';
    }
}