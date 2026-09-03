import * as React from 'react';
import { View, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { ToolCall } from '@/sync/typesMessage';
import { t } from '@/text';
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
            return <ActivityIndicator size="small" color={theme.colors.accent} />;
        case 'completed':
            return <Ionicons name="checkmark-circle" size={22} color="#34C759" />;
        case 'error':
            return <Ionicons name="close-circle" size={22} color="#FF3B30" />;
        case 'cancelled':
            return (
                <Ionicons
                    name="remove-circle-outline"
                    size={22}
                    color={theme.colors.textSecondary}
                    accessibilityLabel={t('toolGroup.subagentStatus.cancelled')}
                />
            );
    }
}

const styles = StyleSheet.create({
    container: {
        width: 22,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
