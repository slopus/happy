import * as React from 'react';
import { View, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ToolCall } from '@/sync/typesMessage';
interface ToolStatusIndicatorProps {
    tool: ToolCall;
}

export function ToolStatusIndicator({ tool }: ToolStatusIndicatorProps) {
    return (
        <View style={styles.container}>
            <StatusIndicator state={tool.state} />
        </View>
    );
}

function StatusIndicator({ state }: { state: ToolCall['state'] }) {
    switch (state) {
        case 'running':
            return <ActivityIndicator size="small" color="#007AFF" />;
        case 'completed':
            return <Ionicons name="checkmark-circle" size={22} color="#34C759" />;
        case 'error':
            return <Ionicons name="close-circle" size={22} color="#FF3B30" />;
        default:
            return null;
    }
}

const styles = StyleSheet.create({
    container: {
        width: 22,
        alignItems: 'center',
        justifyContent: 'center',
    },
});