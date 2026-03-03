import * as React from 'react';
import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

interface DevServerPickerProps {
    servers: Array<{ port: number; title?: string }>;
    onSelect: (url: string) => void;
    onRefreshScan: () => void;
    scanning: boolean;
}

export const DevServerPicker = React.memo(({
    servers,
    onSelect,
    onRefreshScan,
    scanning,
}: DevServerPickerProps) => {
    const { theme } = useUnistyles();

    return (
        <View style={styles.container}>
            <Text style={styles.title}>Select Dev Server</Text>

            {scanning ? (
                <ActivityIndicator
                    size="small"
                    color={theme.colors.textSecondary}
                    style={{ marginVertical: 20 }}
                />
            ) : servers.length === 0 ? (
                <Text style={styles.emptyText}>No dev servers found</Text>
            ) : (
                servers.map((server) => (
                    <Pressable
                        key={server.port}
                        style={styles.serverRow}
                        onPress={() => onSelect(`http://localhost:${server.port}`)}
                    >
                        <Ionicons
                            name="globe-outline"
                            size={20}
                            color={theme.colors.textSecondary}
                        />
                        <Text style={styles.serverPort}>
                            localhost:{server.port}
                        </Text>
                        {server.title ? (
                            <Text
                                style={styles.serverTitle}
                                numberOfLines={1}
                            >
                                {server.title}
                            </Text>
                        ) : null}
                        <View style={{ flex: 1 }} />
                        <Ionicons
                            name="chevron-forward"
                            size={16}
                            color={theme.colors.textSecondary}
                        />
                    </Pressable>
                ))
            )}

            {/* Refresh / scan again button */}
            <Pressable
                onPress={onRefreshScan}
                disabled={scanning}
                style={styles.refreshButton}
            >
                <Ionicons
                    name="refresh-outline"
                    size={16}
                    color={theme.colors.textLink}
                />
                <Text style={styles.refreshText}>Scan again</Text>
            </Pressable>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        padding: 20,
        alignItems: 'center',
        justifyContent: 'center',
    },
    title: {
        fontSize: 16,
        ...Typography.default('semiBold'),
        color: theme.colors.text,
        marginBottom: 16,
    },
    emptyText: {
        fontSize: 14,
        ...Typography.default(),
        color: theme.colors.textSecondary,
        marginBottom: 16,
    },
    serverRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        backgroundColor: theme.colors.groupped.background,
        borderRadius: 10,
        padding: 12,
        marginBottom: 8,
        width: '100%',
    },
    serverPort: {
        fontSize: 14,
        ...Typography.mono('semiBold'),
        color: theme.colors.text,
    },
    serverTitle: {
        fontSize: 13,
        ...Typography.default(),
        color: theme.colors.textSecondary,
        flexShrink: 1,
    },
    refreshButton: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginTop: 16,
        paddingVertical: 8,
        paddingHorizontal: 12,
    },
    refreshText: {
        fontSize: 14,
        ...Typography.default(),
        color: theme.colors.textLink,
    },
}));
