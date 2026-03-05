import * as React from 'react';
import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Switch } from '@/components/Switch';
import { FloatingOverlay } from '@/components/FloatingOverlay';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

interface McpServer {
    name: string;
    enabled: boolean;
    type: string;
    command?: string | null;
    url?: string | null;
}

interface MCPServerPopupProps {
    servers: McpServer[];
    loading: boolean;
    onToggle: (name: string, enabled: boolean) => void;
}

function formatServerName(name: string): string {
    return name.split(/[-_]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

export function MCPServerPopup(props: MCPServerPopupProps) {
    const { servers, loading, onToggle } = props;
    const { theme } = useUnistyles();
    const router = useRouter();

    const enabledCount = servers.filter(s => s.enabled).length;
    const totalCount = servers.length;

    return (
        <FloatingOverlay maxHeight={400} keyboardShouldPersistTaps="always">
            {/* Header */}
            <View style={stylesheet.header}>
                <Text style={[stylesheet.headerTitle, { color: theme.colors.text, ...Typography.default('semiBold') }]}>
                    MCP Servers
                </Text>
                <View style={[stylesheet.countBadge, { backgroundColor: theme.colors.surfacePressed }]}>
                    <Text style={[stylesheet.countText, { color: theme.colors.textSecondary, ...Typography.default() }]}>
                        {enabledCount}/{totalCount}
                    </Text>
                </View>
            </View>

            {/* Server list */}
            {loading ? (
                <View style={stylesheet.loadingContainer}>
                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                </View>
            ) : (
                servers.map((server, index) => (
                    <View
                        key={server.name}
                        style={[
                            stylesheet.serverRow,
                            index < servers.length - 1 && {
                                borderBottomWidth: 0.5,
                                borderBottomColor: theme.colors.divider,
                            },
                        ]}
                    >
                        <View style={stylesheet.serverInfo}>
                            <View
                                style={[
                                    stylesheet.statusDot,
                                    {
                                        backgroundColor: server.enabled
                                            ? '#34C759'
                                            : theme.colors.textSecondary,
                                    },
                                ]}
                            />
                            <View style={stylesheet.serverText}>
                                <Text
                                    style={[
                                        stylesheet.serverName,
                                        { color: theme.colors.text, ...Typography.default('semiBold') },
                                    ]}
                                    numberOfLines={1}
                                >
                                    {formatServerName(server.name)}
                                </Text>
                                <Text
                                    style={[
                                        stylesheet.serverType,
                                        { color: theme.colors.textSecondary, ...Typography.default() },
                                    ]}
                                    numberOfLines={1}
                                >
                                    {server.type}
                                </Text>
                            </View>
                        </View>
                        <Switch
                            value={server.enabled}
                            onValueChange={(value) => onToggle(server.name, value)}
                        />
                    </View>
                ))
            )}

            {/* Footer */}
            <Pressable
                style={({ pressed }) => [
                    stylesheet.footer,
                    {
                        borderTopWidth: 0.5,
                        borderTopColor: theme.colors.divider,
                    },
                    pressed && { backgroundColor: theme.colors.surfacePressed },
                ]}
                onPress={() => router.push('/settings/mcp')}
            >
                <Ionicons
                    name="settings-outline"
                    size={16}
                    color={theme.colors.textLink}
                />
                <Text style={[stylesheet.footerText, { color: theme.colors.textLink, ...Typography.default('semiBold') }]}>
                    Manage Servers...
                </Text>
            </Pressable>
        </FloatingOverlay>
    );
}

const stylesheet = StyleSheet.create({
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    headerTitle: {
        fontSize: 15,
    },
    countBadge: {
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 10,
    },
    countText: {
        fontSize: 12,
    },
    loadingContainer: {
        paddingVertical: 24,
        alignItems: 'center',
        justifyContent: 'center',
    },
    serverRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 10,
    },
    serverInfo: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
        marginRight: 12,
    },
    statusDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
        marginRight: 10,
    },
    serverText: {
        flex: 1,
    },
    serverName: {
        fontSize: 14,
    },
    serverType: {
        fontSize: 12,
        marginTop: 1,
    },
    footer: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
        gap: 6,
    },
    footerText: {
        fontSize: 14,
    },
});
