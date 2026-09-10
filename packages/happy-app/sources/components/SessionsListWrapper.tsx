import * as React from 'react';
import { View, ActivityIndicator, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { SessionsList } from './SessionsList';
import { SessionSearchInput } from './SessionSearchInput';
import { setSessionSearchQuery, useSessionSearchStore } from './sessionSearchStore';
import { Text } from '@/components/StyledText';
import { t } from '@/text';
import { StyleSheet as RNStyleSheet } from 'react-native';
import { EmptyMainScreen } from './EmptyMainScreen';
import { useHasArchivedSessions, useVisibleSessionListViewData } from '@/hooks/useVisibleSessionListViewData';
import { useAllMachines, useSettingMutable } from '@/sync/storage';
import { collectMachineChoices } from '@/sync/machineChoices';

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
    scrollIndicatorTopInset = 0,
    bottomContentInset = 128,
    onScroll,
}: {
    topContentInset?: number;
    scrollIndicatorTopInset?: number;
    bottomContentInset?: number;
    onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
}) => {
    const { theme } = useUnistyles();
    const searchOpen = useSessionSearchStore((state) => state.open);
    const searchQuery = useSessionSearchStore((state) => state.query);
    const loadingHistory = useSessionSearchStore((state) => state.loadingHistory);
    const sessionListViewData = useVisibleSessionListViewData(searchQuery);
    const hasArchivedSessions = useHasArchivedSessions();
    const machines = useAllMachines({ includeOffline: true });
    const machineChoices = React.useMemo(() => collectMachineChoices(machines), [machines]);
    const hasOnlineMachines = machineChoices.some((machine) => machine.online);
    const [, setHideArchivedSessions] = useSettingMutable('hideInactiveSessions');
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

    // The search box stays mounted across every list state so the entry point
    // never disappears; a query swaps the empty screen for a no-results note.
    const trimmedQuery = searchQuery.trim();
    const searchBox = searchOpen ? (
        <SessionSearchInput
            value={searchQuery}
            onChangeText={setSessionSearchQuery}
            topInset={topContentInset}
            loading={loadingHistory}
        />
    ) : null;

    // With an online machine, an archive-only account renders SessionsList's inline archive
    // control. With no reachable machine, the connection problem is the useful primary state and
    // the archive remains available as its secondary action.
    if (sessionListViewData.length === 0 && (!hasArchivedSessions || !hasOnlineMachines)) {
        return (
            <View style={styles.container}>
                {searchBox}
                <View style={styles.emptyStateContainer}>
                    <View style={[styles.emptyStateContentContainer, { paddingTop: topContentInset }]}>
                        {trimmedQuery ? (
                            <Text style={[
                                localStyles.noResultsText,
                                { paddingTop: 24, color: theme.colors.textSecondary },
                            ]}>
                                {t('sessionsFilter.noResultsPlaceholder')}
                            </Text>
                        ) : (
                            <EmptyMainScreen
                                hasArchivedSessions={hasArchivedSessions}
                                onShowArchived={() => setHideArchivedSessions(false)}
                            />
                        )}
                    </View>
                </View>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <SessionsList
                topContentInset={topContentInset}
                scrollIndicatorTopInset={scrollIndicatorTopInset}
                bottomContentInset={bottomContentInset}
                onScroll={onScroll}
                searchQuery={searchQuery}
                onSearchQueryChange={setSessionSearchQuery}
                searchOpen={searchOpen}
            />
        </View>
    );
});

const localStyles = RNStyleSheet.create({
    noResultsText: {
        fontSize: 14,
        textAlign: 'center',
    },
});
