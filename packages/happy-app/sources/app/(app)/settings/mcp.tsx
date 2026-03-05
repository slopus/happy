import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Switch } from '@/components/Switch';
import { getServerUrl } from '@/sync/serverConfig';
import { useAuth } from '@/auth/AuthContext';
import { t } from '@/text';
import { useUnistyles } from 'react-native-unistyles';

interface McpServer {
    name: string;
    enabled: boolean;
}

/**
 * Format a server name from kebab-case/camelCase to Title Case.
 * e.g. "context7" -> "Context7", "page-design-guide" -> "Page Design Guide"
 */
function formatServerName(name: string): string {
    return name
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

export default React.memo(function McpSettingsScreen() {
    const { theme } = useUnistyles();
    const auth = useAuth();
    const [servers, setServers] = React.useState<McpServer[]>([]);
    const [loading, setLoading] = React.useState(true);

    // Fetch MCP servers on mount
    React.useEffect(() => {
        let cancelled = false;

        async function fetchServers() {
            const serverUrl = getServerUrl();
            try {
                const response = await fetch(`${serverUrl}/v1/mcp/servers`, {
                    headers: {
                        'Authorization': `Bearer ${auth.credentials?.token}`,
                    },
                });
                if (!response.ok) {
                    throw new Error(`Failed to fetch MCP servers: ${response.status}`);
                }
                const data = await response.json();
                if (!cancelled) {
                    setServers(data.servers || []);
                }
            } catch (e) {
                console.error('[MCP] Failed to fetch servers:', e);
            } finally {
                if (!cancelled) {
                    setLoading(false);
                }
            }
        }

        fetchServers();
        return () => { cancelled = true; };
    }, [auth.credentials?.token]);

    // Optimistic toggle for a server
    const handleToggle = React.useCallback(async (name: string, currentEnabled: boolean) => {
        const newEnabled = !currentEnabled;

        // Optimistic update
        setServers(prev => prev.map(s =>
            s.name === name ? { ...s, enabled: newEnabled } : s
        ));

        const serverUrl = getServerUrl();
        const action = newEnabled ? 'enable' : 'disable';
        try {
            const response = await fetch(`${serverUrl}/v1/mcp/servers/${name}/${action}`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${auth.credentials?.token}`,
                },
            });
            if (!response.ok) {
                throw new Error(`Failed to ${action} server ${name}: ${response.status}`);
            }
        } catch (e) {
            console.error(`[MCP] Failed to ${action} server ${name}:`, e);
            // Revert on error
            setServers(prev => prev.map(s =>
                s.name === name ? { ...s, enabled: currentEnabled } : s
            ));
        }
    }, [auth.credentials?.token]);

    const activeServers = servers.filter(s => s.enabled);
    const disabledServers = servers.filter(s => !s.enabled);

    if (loading) {
        return (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                <ActivityIndicator size="large" color={theme.colors.text} />
            </View>
        );
    }

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {/* Active Servers */}
            {activeServers.length > 0 && (
                <ItemGroup
                    title={t('settingsMcp.activeServers')}
                    footer={t('settingsMcp.activeServersFooter')}
                >
                    {activeServers.map(server => (
                        <Item
                            key={server.name}
                            title={formatServerName(server.name)}
                            icon={<Ionicons name="extension-puzzle" size={29} color="#34C759" />}
                            rightElement={
                                <Switch
                                    value={server.enabled}
                                    onValueChange={() => handleToggle(server.name, server.enabled)}
                                />
                            }
                            showChevron={false}
                        />
                    ))}
                </ItemGroup>
            )}

            {/* Disabled Servers */}
            {disabledServers.length > 0 && (
                <ItemGroup title={t('settingsMcp.disabledServers')}>
                    {disabledServers.map(server => (
                        <Item
                            key={server.name}
                            title={formatServerName(server.name)}
                            icon={<Ionicons name="extension-puzzle-outline" size={29} color={theme.colors.textSecondary} />}
                            rightElement={
                                <Switch
                                    value={server.enabled}
                                    onValueChange={() => handleToggle(server.name, server.enabled)}
                                />
                            }
                            showChevron={false}
                        />
                    ))}
                </ItemGroup>
            )}

            {/* Empty state */}
            {servers.length === 0 && (
                <ItemGroup>
                    <Item
                        title={t('settingsMcp.noServers')}
                        icon={<Ionicons name="extension-puzzle-outline" size={29} color={theme.colors.textSecondary} />}
                        showChevron={false}
                    />
                </ItemGroup>
            )}
        </ItemList>
    );
});
