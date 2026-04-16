import * as React from 'react';
import { View } from 'react-native';
import { Slot } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { SidebarView } from './SidebarView';
import { ContextPanel } from './ContextPanel';
import { useZenMode } from '@/hooks/useZenMode';

// Three-column desktop layout per docs/layout-core.md:
// SidebarView (~300px) | Center (flex:1, routes via Slot) | ContextPanel (~300px)
// Zen mode (Cmd/Ctrl+0) hides both side panels.
export const DesktopLayout = React.memo(() => {
    const { zen, toggleZen } = useZenMode();

    // Register Cmd/Ctrl+0 for Zen mode toggle (desktop only)
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
            {!zen && (
                <View style={styles.sidebar}>
                    <SidebarView />
                </View>
            )}
            <View style={styles.center}>
                <Slot />
            </View>
            {!zen && (
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
    },
    center: {
        flex: 1,
    },
    contextPanel: {
        width: 300,
        borderLeftWidth: 1,
        borderLeftColor: theme.colors.divider,
    },
}));
