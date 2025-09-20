import * as React from 'react';
import { View, ActivityIndicator } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRealtimeStatus } from '@/sync/storage';
import { useVisibleSessionListViewData } from '@/hooks/useVisibleSessionListViewData';
import { useIsTablet } from '@/utils/responsive';
import { useRouter } from 'expo-router';
import { EmptyMainScreen } from './EmptyMainScreen';
import { EmptySessionsTablet } from './EmptySessionsTablet';
import { UpdateBanner } from './UpdateBanner';
import { SessionsList } from './SessionsList';
import { FABWide } from './FABWide';
import { VoiceAssistantStatusBar } from './VoiceAssistantStatusBar';
import { HomeHeader } from './HomeHeader';

interface MainViewProps {
    variant: 'phone' | 'sidebar';
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
    emptyStateContentContainer: {
        flex: 1,
        flexBasis: 0,
        flexGrow: 1,
    },
}));

export const MainView = React.memo(({ variant }: MainViewProps) => {
    const { theme } = useUnistyles();
    const sessionListViewData = useVisibleSessionListViewData();
    const isTablet = useIsTablet();
    const realtimeStatus = useRealtimeStatus();
    const router = useRouter();

    const handleNewSession = React.useCallback(() => {
        router.push('/new');
    }, [router]);

    // Empty state for tablets (when on tablet phone layout)
    if (variant === 'phone' && isTablet) {
        return (
            <View style={styles.emptyStateContentContainer}>
                {sessionListViewData === null && (
                    <View style={styles.tabletLoadingContainer}>
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    </View>
                )}
                {sessionListViewData !== null && sessionListViewData.length === 0 && (
                    <EmptyMainScreen />
                )}
            </View>
        );
    }

    // Loading state
    if (sessionListViewData === null) {
        if (variant === 'sidebar') {
            return (
                <View style={styles.sidebarContentContainer}>
                    <View style={styles.tabletLoadingContainer}>
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    </View>
                </View>
            );
        }
        
        // Phone variant loading
        return (
            <>
                <HomeHeader />
                {!isTablet && realtimeStatus !== 'disconnected' && (
                    <VoiceAssistantStatusBar variant="full" />
                )}
                <View style={styles.loadingContainerWrapper}>
                    <UpdateBanner />
                    <View style={styles.loadingContainer}>
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    </View>
                </View>
                <FABWide onPress={handleNewSession} />
            </>
        );
    }

    // Empty state
    if (sessionListViewData.length === 0) {
        if (variant === 'sidebar') {
            return (
                <View style={styles.sidebarContentContainer}>
                    <View style={styles.emptyStateContainer}>
                        <UpdateBanner />
                        <EmptySessionsTablet />
                    </View>
                </View>
            );
        }

        // Phone variant empty state
        const emptyState = (
            <View style={styles.emptyStateContainer}>
                <UpdateBanner />
                <View style={styles.emptyStateContentContainer}>
                    <EmptyMainScreen />
                </View>
            </View>
        );

        return (
            <>
                <HomeHeader />
                {!isTablet && realtimeStatus !== 'disconnected' && (
                    <VoiceAssistantStatusBar variant="full" />
                )}
                <View style={styles.phoneContainer}>
                    {emptyState}
                </View>
                <FABWide onPress={handleNewSession} />
            </>
        );
    }

    // Sessions list view
    if (variant === 'sidebar') {
        return (
            <View style={styles.sidebarContentContainer}>
                <SessionsList />
            </View>
        );
    }

    // Phone variant with sessions
    return (
        <>
            <HomeHeader />
            {!isTablet && realtimeStatus !== 'disconnected' && (
                <VoiceAssistantStatusBar variant="full" />
            )}
            <View style={styles.phoneContainer}>
                <SessionsList />
            </View>
            <FABWide onPress={handleNewSession} />
        </>
    );
});
