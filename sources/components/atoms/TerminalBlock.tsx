import React from 'react';
import { View, ScrollView, StyleSheet, ViewStyle } from 'react-native';
import { Text } from '../StyledText';
import { Typography } from '@/constants/Typography';

interface TerminalBlockProps {
    command?: string;
    output?: string;
    error?: string;
    maxHeight?: number;
    style?: ViewStyle;
}

const styles = StyleSheet.create({
    container: {
        backgroundColor: '#1F2937',
        borderRadius: 8,
        overflow: 'hidden',
    },
    commandContainer: {
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: '#374151',
    },
    commandRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    prompt: {
        color: '#10B981',
        fontSize: 14,
        marginRight: 8,
        ...Typography.mono(),
    },
    commandText: {
        color: '#F9FAFB',
        fontSize: 14,
        flex: 1,
        ...Typography.mono(),
    },
    scrollContent: {
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    errorText: {
        color: '#F87171',
        fontSize: 14,
        marginBottom: 8,
        ...Typography.mono(),
    },
    outputText: {
        color: '#D1D5DB',
        fontSize: 14,
        ...Typography.mono(),
    },
    emptyState: {
        paddingHorizontal: 16,
        paddingVertical: 32,
        alignItems: 'center',
    },
    emptyText: {
        color: '#6B7280',
        fontSize: 14,
        fontStyle: 'italic',
        ...Typography.mono(),
    },
});

export function TerminalBlock({ 
    command, 
    output, 
    error,
    maxHeight = 300,
    style 
}: TerminalBlockProps) {
    return (
        <View style={[styles.container, style]}>
            {/* Command line */}
            {command && (
                <View style={styles.commandContainer}>
                    <View style={styles.commandRow}>
                        <Text style={styles.prompt}>$</Text>
                        <Text style={styles.commandText} selectable>
                            {command}
                        </Text>
                    </View>
                </View>
            )}
            
            {/* Output/Error content */}
            {(output || error) && (
                <ScrollView 
                    style={[styles.scrollContent, { maxHeight }]}
                    showsVerticalScrollIndicator={true}
                    nestedScrollEnabled={true}
                >
                    {error && (
                        <Text style={styles.errorText} selectable>
                            {error}
                        </Text>
                    )}
                    {output && (
                        <Text style={styles.outputText} selectable>
                            {output}
                        </Text>
                    )}
                </ScrollView>
            )}
            
            {/* Empty state */}
            {!command && !output && !error && (
                <View style={styles.emptyState}>
                    <Text style={styles.emptyText}>
                        No output
                    </Text>
                </View>
            )}
        </View>
    );
}