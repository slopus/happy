import React, { memo, useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, TextInput, StyleSheet, Modal, ScrollView } from 'react-native';
import { useStore } from '@/store/store';
import { ProjectConfig } from '@/api/projects';

interface Props {
    project: ProjectConfig;
    onClose: () => void;
}

export const NewTaskModal = memo(function NewTaskModal({ project, onClose }: Props) {
    const agents = useStore(s => s.agents);
    const addTask = useStore(s => s.addTask);
    const selectTask = useStore(s => s.selectTask);
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [selectedAgentId, setSelectedAgentId] = useState<string | null>(
        project.agents.length > 0 ? project.agents[0].id : null
    );
    const [loading, setLoading] = useState(false);

    // Show all agents, but highlight project-linked ones
    const projectAgentIds = new Set(project.agents.map(a => a.id));

    const handleCreate = useCallback(async () => {
        if (!selectedAgentId || !title.trim()) return;
        setLoading(true);
        try {
            const task = await addTask(project.id, {
                agentId: selectedAgentId,
                title: title.trim(),
                description: description.trim() || null,
            });
            selectTask(task.id);
            onClose();
        } finally {
            setLoading(false);
        }
    }, [selectedAgentId, title, description, project.id]);

    return (
        <Modal transparent animationType="fade" onRequestClose={onClose}>
            <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onClose}>
                <View style={styles.modal} onStartShouldSetResponder={() => true}>
                    <Text style={styles.modalTitle}>New Task</Text>
                    <Text style={styles.modalSubtitle}>Project: {project.name}</Text>

                    {/* Agent selection */}
                    <Text style={styles.label}>Agent</Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.agentList}>
                        {agents.map(a => (
                            <TouchableOpacity
                                key={a.id}
                                style={[
                                    styles.agentChip,
                                    selectedAgentId === a.id && styles.agentChipActive,
                                    !projectAgentIds.has(a.id) && styles.agentChipDimmed,
                                ]}
                                onPress={() => setSelectedAgentId(a.id)}
                            >
                                <Text style={[
                                    styles.agentChipText,
                                    selectedAgentId === a.id && styles.agentChipTextActive,
                                ]}>
                                    {a.name}
                                </Text>
                                <Text style={styles.agentChipType}>{a.agentType}</Text>
                            </TouchableOpacity>
                        ))}
                    </ScrollView>

                    {/* Title */}
                    <Text style={styles.label}>Title</Text>
                    <TextInput
                        style={styles.input}
                        value={title}
                        onChangeText={setTitle}
                        placeholder="What should the agent do?"
                        autoFocus
                    />

                    {/* Description */}
                    <Text style={styles.label}>Description (optional)</Text>
                    <TextInput
                        style={[styles.input, styles.textArea]}
                        value={description}
                        onChangeText={setDescription}
                        placeholder="Additional context or instructions..."
                        multiline
                        numberOfLines={4}
                    />

                    {/* Actions */}
                    <View style={styles.actions}>
                        <TouchableOpacity style={styles.cancelButton} onPress={onClose}>
                            <Text style={styles.cancelText}>Cancel</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[styles.createButton, (!title.trim() || !selectedAgentId || loading) && styles.buttonDisabled]}
                            onPress={handleCreate}
                            disabled={!title.trim() || !selectedAgentId || loading}
                        >
                            <Text style={styles.createText}>{loading ? 'Creating...' : 'Create Task'}</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </TouchableOpacity>
        </Modal>
    );
});

const styles = StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.4)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    modal: {
        backgroundColor: '#fff',
        borderRadius: 12,
        padding: 24,
        width: 480,
        maxWidth: '90%' as any,
        maxHeight: '80%' as any,
    },
    modalTitle: {
        fontSize: 20,
        fontWeight: '700',
        color: '#333',
        marginBottom: 4,
    },
    modalSubtitle: {
        fontSize: 13,
        color: '#888',
        marginBottom: 20,
    },
    label: {
        fontSize: 13,
        fontWeight: '600',
        color: '#555',
        marginBottom: 6,
        marginTop: 12,
    },
    agentList: {
        flexDirection: 'row',
        marginBottom: 4,
    },
    agentChip: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: '#f0f0f0',
        marginRight: 8,
        alignItems: 'center',
    },
    agentChipActive: {
        backgroundColor: '#1a73e8',
    },
    agentChipDimmed: {
        opacity: 0.5,
    },
    agentChipText: {
        fontSize: 13,
        color: '#333',
        fontWeight: '500',
    },
    agentChipTextActive: {
        color: '#fff',
    },
    agentChipType: {
        fontSize: 10,
        color: '#999',
        marginTop: 2,
    },
    input: {
        borderWidth: 1,
        borderColor: '#ddd',
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        fontSize: 14,
        color: '#333',
        backgroundColor: '#fafafa',
    },
    textArea: {
        minHeight: 80,
        textAlignVertical: 'top',
    },
    actions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        marginTop: 20,
        gap: 12,
    },
    cancelButton: {
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderRadius: 8,
    },
    cancelText: {
        fontSize: 14,
        color: '#666',
    },
    createButton: {
        paddingHorizontal: 20,
        paddingVertical: 10,
        borderRadius: 8,
        backgroundColor: '#1a73e8',
    },
    buttonDisabled: {
        opacity: 0.5,
    },
    createText: {
        fontSize: 14,
        color: '#fff',
        fontWeight: '600',
    },
});
