import React from 'react';
import { View } from 'react-native';
import { Text } from '../StyledText';

interface InfoBoxProps {
    title?: string;
    variant?: 'info' | 'warning' | 'error' | 'success';
    children: React.ReactNode;
    className?: string;
}

const VARIANT_STYLES = {
    info: {
        bg: 'bg-info-container',
        border: 'border-info',
        titleColor: 'text-info',
        textColor: 'text-on-surface'
    },
    warning: {
        bg: 'bg-warning-container',
        border: 'border-warning',
        titleColor: 'text-warning',
        textColor: 'text-on-surface'
    },
    error: {
        bg: 'bg-error-container',
        border: 'border-error',
        titleColor: 'text-error',
        textColor: 'text-on-surface'
    },
    success: {
        bg: 'bg-success-container',
        border: 'border-success',
        titleColor: 'text-success',
        textColor: 'text-on-surface'
    }
};

export function InfoBox({ 
    title, 
    variant = 'info',
    children,
    className = '' 
}: InfoBoxProps) {
    const styles = VARIANT_STYLES[variant];
    
    return (
        <View className={`rounded-lg p-3 border ${styles.bg} ${styles.border} ${className}`}>
            {title && (
                <Text className={`text-sm font-medium ${styles.titleColor} mb-2`}>
                    {title}
                </Text>
            )}
            <View className={styles.textColor}>
                {children}
            </View>
        </View>
    );
}