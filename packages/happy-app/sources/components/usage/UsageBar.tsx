import React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/StyledText';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

interface UsageBarProps {
    label: string;
    value: number;
    maxValue: number;
    color?: string;
    showPercentage?: boolean;
    height?: number;
    compact?: boolean;
}

const styles = StyleSheet.create((theme) => ({
    container: {
        marginVertical: 8,
    },
    compactContainer: {
        marginVertical: 0,
    },
    labelRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginBottom: 4,
    },
    compactLabelRow: {
        marginBottom: 2,
        gap: 8,
    },
    label: {
        fontSize: 14,
        color: theme.colors.text,
    },
    compactLabel: {
        fontSize: 10,
        color: theme.colors.textSecondary,
        fontWeight: '600',
    },
    value: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        fontWeight: '600',
    },
    compactValue: {
        fontSize: 10,
    },
    barContainer: {
        height: 8,
        backgroundColor: theme.colors.divider,
        borderRadius: 4,
        overflow: 'hidden',
    },
    barFill: {
        height: '100%',
        borderRadius: 4,
    }
}));

export const UsageBar: React.FC<UsageBarProps> = ({
    label,
    value,
    maxValue,
    color,
    showPercentage = false,
    height = 8,
    compact = false
}) => {
    const { theme } = useUnistyles();
    const percentage = maxValue > 0 ? (value / maxValue) * 100 : 0;
    const fillColor = color || '#007AFF';
    
    const displayValue = showPercentage 
        ? `${percentage.toFixed(1)}%`
        : value.toLocaleString();
    
    return (
        <View style={[styles.container, compact && styles.compactContainer]}>
            <View style={[styles.labelRow, compact && styles.compactLabelRow]}>
                <Text style={[styles.label, compact && styles.compactLabel]}>{label}</Text>
                <Text style={[styles.value, compact && styles.compactValue]}>{displayValue}</Text>
            </View>
            <View style={[styles.barContainer, { height }]}>
                <View 
                    style={[
                        styles.barFill,
                        { 
                            width: `${Math.min(percentage, 100)}%`,
                            backgroundColor: fillColor
                        }
                    ]}
                />
            </View>
        </View>
    );
};
