import React from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { Text } from '@/components/StyledText';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { UsageDataPoint } from '@/sync/apiUsage';

interface UsageChartProps {
    data: UsageDataPoint[];
    metric: 'tokens' | 'cost';
    height?: number;
    onBarPress?: (dataPoint: UsageDataPoint, index: number) => void;
}

const styles = StyleSheet.create((theme) => ({
    container: {
        marginVertical: 16,
    },
    chartContainer: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        paddingHorizontal: 8,
        paddingBottom: 40, // Space for labels
    },
    barWrapper: {
        flex: 1,
        alignItems: 'center',
        marginHorizontal: 2,
    },
    bar: {
        width: '100%',
        borderRadius: 4,
        minHeight: 2,
    },
    barValue: {
        fontSize: 10,
        color: theme.colors.textSecondary,
        marginBottom: 4,
        fontWeight: '600',
    },
    barLabel: {
        position: 'absolute',
        bottom: -24,
        fontSize: 10,
        color: theme.colors.textSecondary,
        transform: [{ rotate: '-45deg' }],
        width: 60,
        textAlign: 'center',
    },
    emptyState: {
        padding: 32,
        alignItems: 'center',
        justifyContent: 'center',
    },
    emptyText: {
        fontSize: 14,
        color: theme.colors.textSecondary,
    }
}));

export const UsageChart: React.FC<UsageChartProps> = ({
    data,
    metric,
    height = 200,
    onBarPress
}) => {
    const { theme } = useUnistyles();
    
    if (!data || data.length === 0) {
        return (
            <View style={styles.emptyState}>
                <Text style={styles.emptyText}>No usage data available</Text>
            </View>
        );
    }
    
    // Calculate max value for scaling
    const getValueForDataPoint = (point: UsageDataPoint): number => {
        if (metric === 'tokens') {
            return Object.values(point.tokens).reduce((sum, val) => sum + (val || 0), 0);
        } else {
            return Object.values(point.cost).reduce((sum, val) => sum + (val || 0), 0);
        }
    };
    
    const maxValue = Math.max(...data.map(getValueForDataPoint), 1);
    
    // Format date label
    const formatLabel = (timestamp: number): string => {
        const date = new Date(timestamp * 1000);
        const now = new Date();
        const isToday = date.toDateString() === now.toDateString();
        
        if (isToday) {
            return date.toLocaleTimeString('en-US', { hour: 'numeric' });
        } else {
            return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        }
    };
    
    // Format value for display
    const formatValue = (value: number): string => {
        if (metric === 'cost') {
            return `$${value.toFixed(2)}`;
        } else if (value >= 1000000) {
            return `${(value / 1000000).toFixed(1)}M`;
        } else if (value >= 1000) {
            return `${(value / 1000).toFixed(1)}K`;
        } else {
            return value.toFixed(0);
        }
    };
    
    // Limit bars to show (for better visibility)
    const maxBarsToShow = 30;
    const displayData = data.length > maxBarsToShow 
        ? data.slice(-maxBarsToShow) 
        : data;
    
    return (
        <View style={styles.container}>
            <ScrollView 
                horizontal 
                showsHorizontalScrollIndicator={false}
                bounces={false}
            >
                <View style={[styles.chartContainer, { height }]}>
                    {displayData.map((point, index) => {
                        const value = getValueForDataPoint(point);
                        const barHeight = (value / maxValue) * height;
                        const showValue = value > 0 && barHeight > 20;
                        
                        return (
                            <Pressable
                                key={`${point.timestamp}-${index}`}
                                style={[styles.barWrapper, { minWidth: 40 }]}
                                onPress={() => onBarPress?.(point, index)}
                            >
                                {showValue && (
                                    <Text style={styles.barValue}>
                                        {formatValue(value)}
                                    </Text>
                                )}
                                <View
                                    style={[
                                        styles.bar,
                                        {
                                            height: Math.max(barHeight, 2),
                                            backgroundColor: metric === 'cost' 
                                                ? '#FF9500' 
                                                : '#007AFF',
                                        }
                                    ]}
                                />
                                <Text style={styles.barLabel}>
                                    {formatLabel(point.timestamp)}
                                </Text>
                            </Pressable>
                        );
                    })}
                </View>
            </ScrollView>
        </View>
    );
};