import * as React from 'react';
import { View, Pressable, Text } from 'react-native';
import { Slot } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { SidebarView } from './SidebarView';
import { ContextPanel } from './ContextPanel';
import { useZenMode } from '@/hooks/useZenMode';

// Three-column desktop layout per docs/layout-core.md:
// SidebarView (~300px) | Center (flex:1, routes via Slot) | ContextPanel (~300px)
// Left/right panels can be individually toggled. Cmd/Ctrl+0 toggles both (Zen mode).
export const DesktopLayout = React.memo(() => {
    const { zen, toggleZen } = useZenMode();
    const [sidebarVisible, setSidebarVisible] = React.useState(true);
    const [contextVisible, setContextVisible] = React.useState(true);

    // Zen mode overrides individual panel state
    React.useEffect(() => {
        if (zen) {
            setSidebarVisible(false);
            setContextVisible(false);
        } else {
            setSidebarVisible(true);
            setContextVisible(true);
        }
    }, [zen]);

    // Register Cmd/Ctrl+0 for Zen mode toggle
    React.useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === '0') {
                e.preventDefault();
                toggleZen();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [toggleZen]);

    return (
        <View style={styles.container}>
            {sidebarVisible && (
                <View style={styles.sidebar}>
                    <SidebarView />
                </View>
            )}
            <View style={styles.center}>
                {/* Toggle buttons at top of center column */}
                <View style={styles.toggleBar}>
                    <Pressable
                        onPress={() => setSidebarVisible(v => !v)}
                        style={styles.toggleButton}
                    >
                        <Text style={styles.toggleText}>{sidebarVisible ? '◀' : '▶'}</Text>
                    </Pressable>
                    <View style={styles.toggleSpacer} />
                    <Pressable
                        onPress={() => setContextVisible(v => !v)}
                        style={styles.toggleButton}
                    >
                        <Text style={styles.toggleText}>{contextVisible ? '▶' : '◀'}</Text>
                    </Pressable>
                </View>
                <View style={styles.centerContent}>
                    <Slot />
                </View>
            </View>
            {contextVisible && (
                <View style={styles.contextPanel}>
                    <ContextPanel />
                </View>
            )}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        flexDirection: 'row',
    },
    sidebar: {
        width: 300,
        borderRightWidth: 1,
        borderRightColor: theme.colors.divider,
        overflow: 'hidden',
    },
    center: {
        flex: 1,
    },
    centerContent: {
        flex: 1,
    },
    toggleBar: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        paddingHorizontal: 4,
        paddingVertical: 2,
        backgroundColor: theme.colors.surface,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    toggleButton: {
        padding: 4,
        borderRadius: 4,
    },
    toggleText: {
        fontSize: 10,
        color: theme.colors.textSecondary,
    },
    toggleSpacer: {
        flex: 1,
    },
    contextPanel: {
        width: 300,
        borderLeftWidth: 1,
        borderLeftColor: theme.colors.divider,
    },
}));
