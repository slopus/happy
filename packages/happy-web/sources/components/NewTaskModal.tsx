import React, { memo, useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, TextInput, StyleSheet, Modal, ScrollView, Pressable } from 'react-native';
import { useStore } from '@/store/store';
import { ProjectConfig } from '@/api/projects';

interface Props {
    project: ProjectConfig;
    onClose: () => void;
}

function autoTitle(prompt: string): string {
    const first = prompt.split('\n')[0].trim();
    if (first.length <= 60) return first;
    return first.slice(0, 57) + '...';
}

export const NewTaskModal = memo(function NewTaskModal({ project, onClose }: Props) {
    const agents = useStore(s => s.agents);
    const addTask = useStore(s => s.addTask);
    const selectTask = useStore(s => s.selectTask);
    const [prompt, setPrompt] = useState('');
    const [mode, setMode] = useState<'execute' | 'plan'>('execute');
    const [yolo, setYolo] = useState(false);
    const [selectedAgentId, setSelectedAgentId] = useState<string | null>(
        project.agents.length > 0 ? project.agents[0].id : (agents.length > 0 ? agents[0].id : null)
    );
    const [loading, setLoading] = useState(false);

    const projectAgentIds = new Set(project.agents.map(a => a.id));

    const handleCreate = useCallback(async () => {
        if (!selectedAgentId || !prompt.trim()) return;
        setLoading(true);
        try {
            const title = autoTitle(prompt);
            const modePrefix = mode === 'plan' ? '[Plan] ' : '';
            const task = await addTask(project.id, {
                agentId: selectedAgentId,
                title: modePrefix + title,
                description: prompt.trim(),
            }, { yolo });
            selectTask(task.id);
            onClose();
        } finally {
            setLoading(false);
        }
    }, [selectedAgentId, prompt, mode, yolo, project.id]);

    const canCreate = prompt.trim() && selectedAgentId;

    return (
        <Modal transparent animationType="fade" onRequestClose={onClose}>
            <Pressable style={styles.overlay} onPress={(e) => { if (e.target === e.currentTarget) onClose(); }}>
                <View style={styles.modal}>
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

                    {/* Mode toggle */}
                    <Text style={styles.label}>Mode</Text>
                    <View style={styles.modeRow}>
                        <TouchableOpacity
                            style={[styles.modeButton, mode === 'execute' && styles.modeButtonActive]}
                            onPress={() => setMode('execute')}
                        >
                            <Text style={[styles.modeText, mode === 'execute' && styles.modeTextActive]}>Execute</Text>
                            <Text style={styles.modeHint}>Agent acts immediately</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[styles.modeButton, mode === 'plan' && styles.modeButtonActive]}
                            onPress={() => setMode('plan')}
                        >
                            <Text style={[styles.modeText, mode === 'plan' && styles.modeTextActive]}>Plan</Text>
                            <Text style={styles.modeHint}>Agent proposes a plan first</Text>
                        </TouchableOpacity>
                    </View>

                    {/* Yolo mode */}
                    <TouchableOpacity
                        style={styles.yoloRow}
                        onPress={() => setYolo(!yolo)}
                    >
                        <View style={[styles.yoloCheck, yolo && styles.yoloCheckActive]}>
                            {yolo && <Text style={styles.yoloCheckMark}>✓</Text>}
                        </View>
                        <View>
                            <Text style={styles.yoloLabel}>YOLO Mode</Text>
                            <Text style={styles.yoloHint}>Skip all permission prompts (--dangerously-skip-permissions)</Text>
                        </View>
                    </TouchableOpacity>

                    {/* Prompt */}
                    <Text style={styles.label}>What should the agent do?</Text>
                    <TextInput
                        style={[styles.input, styles.textArea]}
                        value={prompt}
                        onChangeText={setPrompt}
                        placeholder="Describe the task..."
                        multiline
                        numberOfLines={5}
                        autoFocus
                    />

                    {/* Actions */}
                    <View style={styles.actions}>
                        <TouchableOpacity style={styles.cancelButton} onPress={onClose}>
                            <Text style={styles.cancelText}>Cancel</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[styles.createButton, !canCreate && styles.buttonDisabled]}
                            onPress={handleCreate}
                            disabled={!canCreate || loading}
                        >
                            <Text style={styles.createText}>
                                {loading ? 'Creating...' : mode === 'plan' ? 'Create Plan' : 'Create Task'}
                            </Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </Pressable>
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
        width: 520,
        maxWidth: '90%' as any,
        maxHeight: '85%' as any,
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
        marginBottom: 16,
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
    modeRow: {
        flexDirection: 'row',
        gap: 10,
    },
    modeButton: {
        flex: 1,
        padding: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: '#e0e0e0',
        backgroundColor: '#fafafa',
    },
    modeButtonActive: {
        borderColor: '#1a73e8',
        backgroundColor: '#e8f0fe',
    },
    modeText: {
        fontSize: 14,
        fontWeight: '600',
        color: '#333',
        marginBottom: 2,
    },
    modeTextActive: {
        color: '#1a73e8',
    },
    modeHint: {
        fontSize: 11,
        color: '#999',
    },
    yoloRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: 14,
        padding: 10,
        borderRadius: 8,
        backgroundColor: '#fff8e1',
        borderWidth: 1,
        borderColor: '#ffe082',
    },
    yoloCheck: {
        width: 20,
        height: 20,
        borderRadius: 4,
        borderWidth: 2,
        borderColor: '#ccc',
        marginRight: 10,
        alignItems: 'center',
        justifyContent: 'center',
    },
    yoloCheckActive: {
        borderColor: '#f57c00',
        backgroundColor: '#f57c00',
    },
    yoloCheckMark: {
        color: '#fff',
        fontSize: 12,
        fontWeight: '700',
    },
    yoloLabel: {
        fontSize: 13,
        fontWeight: '600',
        color: '#e65100',
    },
    yoloHint: {
        fontSize: 11,
        color: '#999',
        marginTop: 1,
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
        minHeight: 100,
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
