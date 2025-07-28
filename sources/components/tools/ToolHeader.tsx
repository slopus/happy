import * as React from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ToolCall } from '@/sync/typesMessage';
import { knownTools } from '@/components/tools/knownTools';

interface ToolHeaderProps {
    tool: ToolCall;
}

export function ToolHeader({ tool }: ToolHeaderProps) {
    const toolTitle = tool.name in knownTools ? knownTools[tool.name as keyof typeof knownTools].title : tool.name;
    const knownTool = knownTools[tool.name as keyof typeof knownTools] as any;
    const icon = knownTool?.icon || 'construct';
    
    // Extract subtitle using the same logic as ToolView
    let subtitle = null;
    if (knownTool && typeof knownTool.extractSubtitle === 'function') {
        const extractedSubtitle = knownTool.extractSubtitle({ tool, metadata: null });
        if (typeof extractedSubtitle === 'string' && extractedSubtitle) {
            subtitle = extractedSubtitle;
        }
    }

    return (
        <View style={styles.container}>
            <View style={styles.titleContainer}>
                <View style={styles.titleRow}>
                    <Ionicons name={icon as any} size={18} color="#5856D6" />
                    <Text style={styles.title} numberOfLines={1}>{toolTitle}</Text>
                </View>
                {subtitle && (
                    <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text>
                )}
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
        flex: 1,
        paddingHorizontal: 4,
    },
    titleContainer: {
        flexDirection: 'column',
        alignItems: 'center',
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    title: {
        fontSize: 15,
        fontWeight: '600',
        color: '#000',
        textAlign: 'center',
    },
    subtitle: {
        fontSize: 11,
        color: '#666',
        textAlign: 'center',
        marginTop: 2,
    },
});