import React, { memo, useCallback, useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import { Sidebar } from '@/components/Sidebar';
import { TaskDetail } from '@/components/TaskDetail';
import { useStore } from '@/store/store';

const Home = memo(function Home() {
    const loadProjects = useStore(s => s.loadProjects);
    const loadAgents = useStore(s => s.loadAgents);
    const selectedTaskId = useStore(s => s.selectedTaskId);

    useEffect(() => {
        loadProjects();
        loadAgents();
    }, []);

    return (
        <View style={styles.container}>
            <View style={styles.sidebar}>
                <Sidebar />
            </View>
            <View style={styles.main}>
                {selectedTaskId ? (
                    <TaskDetail taskId={selectedTaskId} />
                ) : (
                    <View style={styles.empty}>
                        {/* Empty state placeholder */}
                    </View>
                )}
            </View>
        </View>
    );
});

export default Home;

const styles = StyleSheet.create({
    container: {
        flex: 1,
        flexDirection: 'row',
        backgroundColor: '#f5f5f5',
        height: '100%' as any,
    },
    sidebar: {
        width: 320,
        borderRightWidth: 1,
        borderRightColor: '#e0e0e0',
        backgroundColor: '#ffffff',
    },
    main: {
        flex: 1,
        backgroundColor: '#ffffff',
    },
    empty: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
