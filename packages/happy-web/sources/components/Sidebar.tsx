import React, { memo, useCallback, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, TextInput } from 'react-native';
import { useStore } from '@/store/store';
import { NewTaskModal } from './NewTaskModal';
import { ProjectConfig } from '@/api/projects';
import { TaskConfig } from '@/api/tasks';

export const Sidebar = memo(function Sidebar() {
    const projects = useStore(s => s.projects);
    const selectedProjectId = useStore(s => s.selectedProjectId);
    const selectProject = useStore(s => s.selectProject);
    const tasks = useStore(s => s.tasks);
    const selectedTaskId = useStore(s => s.selectedTaskId);
    const selectTask = useStore(s => s.selectTask);
    const [showNewTask, setShowNewTask] = useState(false);

    const selectedProject = projects.find(p => p.id === selectedProjectId);

    return (
        <View style={styles.container}>
            {/* Project selector */}
            <View style={styles.projectSelector}>
                <Text style={styles.sectionLabel}>Project</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.projectList}>
                    {projects.map(p => (
                        <TouchableOpacity
                            key={p.id}
                            style={[styles.projectChip, selectedProjectId === p.id && styles.projectChipActive]}
                            onPress={() => selectProject(p.id)}
                        >
                            <Text style={[styles.projectChipText, selectedProjectId === p.id && styles.projectChipTextActive]}>
                                {p.name}
                            </Text>
                        </TouchableOpacity>
                    ))}
                </ScrollView>
            </View>

            {/* Task list */}
            {selectedProject && (
                <>
                    <View style={styles.taskHeader}>
                        <Text style={styles.sectionLabel}>Tasks</Text>
                        <TouchableOpacity style={styles.newTaskButton} onPress={() => setShowNewTask(true)}>
                            <Text style={styles.newTaskButtonText}>+ New</Text>
                        </TouchableOpacity>
                    </View>
                    <ScrollView style={styles.taskList}>
                        {tasks.map(t => (
                            <TaskItem
                                key={t.id}
                                task={t}
                                selected={selectedTaskId === t.id}
                                onPress={() => selectTask(t.id)}
                            />
                        ))}
                        {tasks.length === 0 && (
                            <Text style={styles.emptyText}>No tasks yet</Text>
                        )}
                    </ScrollView>
                </>
            )}

            {!selectedProject && projects.length > 0 && (
                <View style={styles.emptyContainer}>
                    <Text style={styles.emptyText}>Select a project</Text>
                </View>
            )}

            {projects.length === 0 && (
                <View style={styles.emptyContainer}>
                    <Text style={styles.emptyText}>No projects yet</Text>
                    <Text style={styles.emptyHint}>Go to Settings to create one</Text>
                </View>
            )}

            {/* Settings link */}
            <TouchableOpacity style={styles.settingsButton} onPress={() => {
                // Using window.location for now since we need a simple navigation
                if (typeof window !== 'undefined') {
                    window.location.href = '/settings';
                }
            }}>
                <Text style={styles.settingsText}>Settings</Text>
            </TouchableOpacity>

            {/* New task modal */}
            {showNewTask && selectedProject && (
                <NewTaskModal
                    project={selectedProject}
                    onClose={() => setShowNewTask(false)}
                />
            )}
        </View>
    );
});

const TaskItem = memo(function TaskItem({ task, selected, onPress }: {
    task: TaskConfig;
    selected: boolean;
    onPress: () => void;
}) {
    const statusColors: Record<string, string> = {
        running: '#4caf50',
        waiting_for_permission: '#ff9800',
        done: '#9e9e9e',
        failed: '#f44336',
    };

    return (
        <TouchableOpacity
            style={[styles.taskItem, selected && styles.taskItemActive]}
            onPress={onPress}
        >
            <View style={styles.taskItemHeader}>
                <View style={[styles.statusDot, { backgroundColor: statusColors[task.status] || '#9e9e9e' }]} />
                <Text style={styles.taskAgentName} numberOfLines={1}>{task.agent.name}</Text>
            </View>
            <Text style={styles.taskTitle} numberOfLines={2}>{task.title}</Text>
            <Text style={styles.taskStatus}>{task.status.replace(/_/g, ' ')}</Text>
        </TouchableOpacity>
    );
});

const styles = StyleSheet.create({
    container: {
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
    },
    projectSelector: {
        padding: 16,
        borderBottomWidth: 1,
        borderBottomColor: '#e0e0e0',
    },
    sectionLabel: {
        fontSize: 12,
        fontWeight: '600',
        color: '#888',
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        marginBottom: 8,
    },
    projectList: {
        flexDirection: 'row',
    },
    projectChip: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 16,
        backgroundColor: '#f0f0f0',
        marginRight: 8,
    },
    projectChipActive: {
        backgroundColor: '#1a73e8',
    },
    projectChipText: {
        fontSize: 13,
        color: '#333',
    },
    projectChipTextActive: {
        color: '#fff',
    },
    taskHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingTop: 16,
        paddingBottom: 8,
    },
    newTaskButton: {
        paddingHorizontal: 12,
        paddingVertical: 4,
        borderRadius: 12,
        backgroundColor: '#1a73e8',
    },
    newTaskButtonText: {
        color: '#fff',
        fontSize: 13,
        fontWeight: '600',
    },
    taskList: {
        flex: 1,
    },
    taskItem: {
        padding: 12,
        marginHorizontal: 8,
        marginVertical: 2,
        borderRadius: 8,
    },
    taskItemActive: {
        backgroundColor: '#e8f0fe',
    },
    taskItemHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 4,
    },
    statusDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
        marginRight: 6,
    },
    taskAgentName: {
        fontSize: 12,
        color: '#666',
        fontWeight: '500',
    },
    taskTitle: {
        fontSize: 14,
        color: '#333',
        fontWeight: '500',
        marginBottom: 2,
    },
    taskStatus: {
        fontSize: 11,
        color: '#999',
        textTransform: 'capitalize',
    },
    emptyContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
    },
    emptyText: {
        fontSize: 14,
        color: '#999',
        textAlign: 'center',
        padding: 20,
    },
    emptyHint: {
        fontSize: 12,
        color: '#bbb',
        textAlign: 'center',
    },
    settingsButton: {
        padding: 16,
        borderTopWidth: 1,
        borderTopColor: '#e0e0e0',
        alignItems: 'center',
    },
    settingsText: {
        fontSize: 14,
        color: '#1a73e8',
        fontWeight: '500',
    },
});
