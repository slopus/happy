import React, { memo, useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, Text, ActivityIndicator } from 'react-native';
import { Sidebar } from '@/components/Sidebar';
import { TaskDetail } from '@/components/TaskDetail';
import { useStore } from '@/store/store';
import { ensureDevAuth } from '@/api/client';

const Home = memo(function Home() {
    const loadProjects = useStore(s => s.loadProjects);
    const loadAgents = useStore(s => s.loadAgents);
    const selectedTaskId = useStore(s => s.selectedTaskId);
    const [ready, setReady] = useState(false);

    useEffect(() => {
        ensureDevAuth().then(() => {
            setReady(true);
            loadProjects();
            loadAgents();
        });
    }, []);

    if (!ready) {
        return (
            <View style={styles.loading}>
                <ActivityIndicator size="large" color="#1a73e8" />
                <Text style={styles.loadingText}>Connecting...</Text>
            </View>
        );
    }

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
    loading: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#f5f5f5',
    },
    loadingText: {
        marginTop: 12,
        fontSize: 14,
        color: '#666',
    },
});
