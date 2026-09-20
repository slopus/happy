import * as React from 'react';
import { View, ActivityIndicator, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { SessionsList } from './SessionsList';
import { EmptyMainScreen } from './EmptyMainScreen';
import { ProjectHomeList } from './ProjectHomeList';
import { useHasArchivedSessions, useVisibleSessionListViewData } from '@/hooks/useVisibleSessionListViewData';
import { useAllMachines, useSetting, useSettingMutable } from '@/sync/storage';
import { collectMachineChoices } from '@/sync/machineChoices';
import { LinkComputerChecklist } from './onboarding/LinkComputer';
import { resolveHomeEmptyState } from './onboarding/firstRunOnboarding';

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
    const sessionListViewData = useVisibleSessionListViewData();
    const hasArchivedSessions = useHasArchivedSessions();
    const machines = useAllMachines({ includeOffline: true });
    const machineChoices = React.useMemo(() => collectMachineChoices(machines), [machines]);
    const onlineMachineCount = machineChoices.filter((machine) => machine.online).length;
    const [, setHideArchivedSessions] = useSettingMutable('hideInactiveSessions');
    // The activity-sorted chat list is the default; the project hierarchy —
    // project, then checkout, with chats as tabs — is the other layout.
    const groupByProject = useSetting('sessionListGrouping') === 'project';
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

    const emptyState = resolveHomeEmptyState({
        visibleSessionCount: sessionListViewData.length,
        hasArchivedSessions,
        machineCount: machineChoices.length,
        onlineMachineCount,
    });

    // Every linked computer is offline and there is nothing to list: the
    // checklist that got the first computer linked, now about getting it
    // running again. On phones the no-machine case never reaches here (the
    // home route shows the first-run screen); web and desktop keep their own.
    if (emptyState === 'offline') {
        return (
            <View style={styles.container}>
                <View style={styles.emptyStateContainer}>
                    <View style={[styles.emptyStateContentContainer, { paddingTop: topContentInset, paddingBottom: bottomContentInset }]}>
                        <LinkComputerChecklist
                            variant="offline"
                            onShowArchived={hasArchivedSessions ? () => setHideArchivedSessions(false) : undefined}
                        />
                    </View>
                </View>
            </View>
        );
    }

    if (emptyState === 'link' || emptyState === 'no-sessions') {
        return (
            <View style={styles.container}>
                <View style={styles.emptyStateContainer}>
                    <View style={[styles.emptyStateContentContainer, { paddingTop: topContentInset, paddingBottom: bottomContentInset }]}>
                        <EmptyMainScreen
                            hasArchivedSessions={hasArchivedSessions}
                            onShowArchived={() => setHideArchivedSessions(false)}
                        />
                    </View>
                </View>
            </View>
        );
    }

    if (groupByProject) {
        return (
            <View style={styles.container}>
                <ProjectHomeList
                    topContentInset={topContentInset}
                    scrollIndicatorTopInset={scrollIndicatorTopInset}
                    bottomContentInset={bottomContentInset}
                    onScroll={onScroll}
                />
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
            />
        </View>
    );
});
