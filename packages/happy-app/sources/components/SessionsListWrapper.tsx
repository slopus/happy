import * as React from 'react';
import { View, ActivityIndicator, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { SessionsList } from './SessionsList';
import { EmptyMainScreen } from './EmptyMainScreen';
import { useVisibleSessionListViewData } from '@/hooks/useVisibleSessionListViewData';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
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

export const SessionsListWrapper = React.memo(({
    topContentInset = 0,
    bottomContentInset = 128,
    onScroll,
    searchQuery = '',
}: {
    topContentInset?: number;
    bottomContentInset?: number;
    onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
    searchQuery?: string;
}) => {
    const { theme } = useUnistyles();
    const sessionListViewData = useVisibleSessionListViewData();
    const styles = stylesheet;

    if (sessionListViewData === null) {
        return (
            <View style={styles.container}>
                <View style={[styles.loadingContainerWrapper, { paddingTop: topContentInset }]}>
                    <View style={styles.loadingContainer}>
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    </View>
                </View>
            </View>
        );
    }

    if (sessionListViewData.length === 0) {
        return (
            <View style={styles.container}>
                <View style={styles.emptyStateContainer}>
                    <View style={[styles.emptyStateContentContainer, { paddingTop: topContentInset }]}>
                        <EmptyMainScreen />
                    </View>
                </View>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <SessionsList
                topContentInset={topContentInset}
                bottomContentInset={bottomContentInset}
                onScroll={onScroll}
                searchQuery={searchQuery}
            />
        </View>
    );
});
