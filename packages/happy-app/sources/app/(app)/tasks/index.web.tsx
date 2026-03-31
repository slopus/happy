import * as React from 'react';
import { View, Text, TouchableOpacity, ScrollView, TextInput, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useAuth } from '@/auth/AuthContext';
import { useTaskManagerStore, useTaskManagerActions } from '@/hooks/useTaskManager';
import { TaskDetailView } from '@/components/web/TaskDetailView';
import { TaskManagerSidebar } from '@/components/web/TaskManagerSidebar';
import { t } from '@/text';

export default React.memo(function TaskManagerScreen() {
    const { isAuthenticated } = useAuth();
    const { loadProjects, loadAgents, loadMachines } = useTaskManagerActions();
    const selectedTaskId = useTaskManagerStore(s => s.selectedTaskId);

    React.useEffect(() => {
        if (!isAuthenticated) return;
        loadProjects();
        loadAgents();
        loadMachines();
        const interval = setInterval(loadMachines, 30000);
        return () => clearInterval(interval);
    }, [isAuthenticated]);

    if (!isAuthenticated) {
        return (
            <View style={styles.loading}>
                <Text style={styles.loadingText}>{t('status.connecting')}</Text>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <View style={styles.sidebar}>
                <TaskManagerSidebar />
            </View>
            <View style={styles.main}>
                {selectedTaskId ? (
                    <TaskDetailView taskId={selectedTaskId} />
                ) : (
                    <View style={styles.empty}>
                        <Text style={styles.emptyText}>{t('taskManager.selectTask')}</Text>
                    </View>
                )}
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        flexDirection: 'row',
        backgroundColor: theme.colors.groupped.background,
    },
    sidebar: {
        width: 320,
        borderRightWidth: 1,
        borderRightColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    main: {
        flex: 1,
        backgroundColor: theme.colors.surface,
    },
    empty: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    emptyText: {
        fontSize: 14,
        color: theme.colors.textSecondary,
    },
    loading: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.groupped.background,
    },
    loadingText: {
        fontSize: 14,
        color: theme.colors.textSecondary,
    },
}));
