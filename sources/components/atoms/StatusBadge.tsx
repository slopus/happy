import React from 'react';
import { View } from 'react-native';
import { Text } from '../StyledText';

export type ToolState = 'running' | 'completed' | 'error' | 'pending';

interface StatusBadgeProps {
    state: ToolState;
    className?: string;
}

const STATUS_CONFIG = {
    running: {
        icon: '⏳',
        text: 'Running',
        bgColor: 'bg-warning-container',
        borderColor: 'border-warning',
        textColor: 'text-warning'
    },
    completed: {
        icon: '✅',
        text: 'Completed',
        bgColor: 'bg-success-container',
        borderColor: 'border-success',
        textColor: 'text-success'
    },
    error: {
        icon: '❌',
        text: 'Error',
        bgColor: 'bg-error-container',
        borderColor: 'border-error',
        textColor: 'text-error'
    },
    pending: {
        icon: '⏸️',
        text: 'Pending',
        bgColor: 'bg-surface-variant',
        borderColor: 'border-outline',
        textColor: 'text-on-surface-variant'
    }
};

export function StatusBadge({ state, className = '' }: StatusBadgeProps) {
    const config = STATUS_CONFIG[state];
    
    return (
        <View className={`px-2 py-1 rounded-xl border ${config.bgColor} ${config.borderColor} ${className}`}>
            <Text className={`text-sm font-medium ${config.textColor}`}>
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

// Helper function to get the color class for status text
export function getStatusColorClass(state: string): string {
    switch (state) {
        case 'running': return 'text-warning';
        case 'completed': return 'text-success';
        case 'error': return 'text-error';
        case 'pending': return 'text-on-surface-variant';
        default: return 'text-on-surface-variant';
    }
}