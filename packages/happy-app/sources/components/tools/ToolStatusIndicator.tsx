import * as React from 'react';
import { View, ActivityIndicator } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
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
    const { theme } = useUnistyles();
    switch (state) {
        case 'running':
            return <ActivityIndicator size="small" color={theme.colors.blue.standard} />;
        case 'completed':
            return <Ionicons name="checkmark-circle" size={22} color={theme.colors.green.standard} />;
        case 'error':
            return <Ionicons name="close-circle" size={22} color={theme.colors.red.standard} />;
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
