import * as React from 'react';
import { View, ActivityIndicator } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRealtimeStatus } from '@/sync/storage';
import { useVisibleSessionListViewData } from '@/hooks/useVisibleSessionListViewData';
import { EmptySessionsTablet } from './EmptySessionsTablet';
import { SessionsList } from './SessionsList';
import { ComposeHome } from './ComposeHome';
import { VoiceAssistantStatusBar } from './VoiceAssistantStatusBar';
import { Typography } from '@/constants/Typography';

interface MainViewProps {
    variant: 'phone' | 'sidebar';
    sessionListLayout?: 'projects' | 'time';
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
    },
    phoneContainer: {
        flex: 1,
    },
    sidebarContentContainer: {
        flex: 1,
        flexBasis: 0,
        flexGrow: 1,
    },
    loadingContainerWrapper: {
        flex: 1,
        flexBasis: 0,
        flexGrow: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    loadingContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingBottom: 32,
    },
    tabletLoadingContainer: {
        flex: 1,
        flexBasis: 0,
        flexGrow: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    emptyStateContainer: {
        flex: 1,
        flexBasis: 0,
        flexGrow: 1,
        flexDirection: 'column',
        backgroundColor: theme.colors.groupped.background,
    },
    titleContainer: {
        flex: 1,
        alignItems: 'center',
    },
    titleText: {
        fontSize: 17,
        color: theme.colors.header.tint,
        fontWeight: '600',
        ...Typography.default('semiBold'),
    },
    statusContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: -2,
    },
    statusText: {
        fontSize: 12,
        fontWeight: '500',
        lineHeight: 16,
        ...Typography.default(),
    },
    headerButton: {
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));

export const MainView = React.memo(({ sessionListLayout = 'projects', variant }: MainViewProps) => {
    const { theme } = useUnistyles();
    const sessionListViewData = useVisibleSessionListViewData();
    const realtimeStatus = useRealtimeStatus();

    // Sidebar variant
    if (variant === 'sidebar') {
        // Loading state
        if (sessionListViewData === null) {
            return (
                <View style={styles.sidebarContentContainer}>
                    <View style={styles.tabletLoadingContainer}>
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    </View>
                </View>
            );
        }

        // Empty state
        if (sessionListViewData.length === 0) {
            return (
                <View style={styles.sidebarContentContainer}>
                    <View style={styles.emptyStateContainer}>
                        <EmptySessionsTablet />
                    </View>
                </View>
            );
        }

        // Sessions list
        return (
            <View style={styles.sidebarContentContainer}>
                <SessionsList layoutMode={sessionListLayout} />
            </View>
        );
    }

    // 首页主区域在所有宽度下都保持 compose-first；宽屏差异只由外层侧栏承担。
    // The session list now lives in the swipe drawer (SidebarView); settings sits in
    // the top-left of ComposeHome. The old bottom TabBar + per-tab content is gone.
    return (
        <View style={styles.phoneContainer}>
            {realtimeStatus !== 'disconnected' && (
                <View style={{ backgroundColor: theme.colors.groupped.background }}>
                    <VoiceAssistantStatusBar variant="full" />
                </View>
            )}
            <ComposeHome />
        </View>
    );
});
