import React, { memo, useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, TextInput, Modal, ScrollView, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useTaskManagerStore, useTaskManagerActions } from '@/hooks/useTaskManager';
import { ProjectConfig } from '@/sync/apiProjects';
import { t } from '@/text';

interface Props {
    project: ProjectConfig;
    onClose: () => void;
}

function autoTitle(prompt: string): string {
    const first = prompt.split('\n')[0].trim();
    if (first.length <= 60) return first;
    return first.slice(0, 57) + '...';
}

export const NewTaskModalWeb = memo(function NewTaskModalWeb({ project, onClose }: Props) {
    const { theme } = useUnistyles();
    const agents = useTaskManagerStore(s => s.agents);
    const { addTask } = useTaskManagerActions();
    const selectTask = useTaskManagerStore(s => s.selectTask);
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
            if (task) {
                selectTask(task.id);
            }
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
                    <Text style={styles.modalTitle}>{t('taskManager.newTask')}</Text>
                    <Text style={styles.modalSubtitle}>{t('taskManager.project')}: {project.name}</Text>

                    {/* Agent selection */}
                    <Text style={styles.label}>{t('taskManager.agent')}</Text>
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
                    <Text style={styles.label}>{t('taskManager.mode')}</Text>
                    <View style={styles.modeRow}>
                        <TouchableOpacity
                            style={[styles.modeButton, mode === 'execute' && styles.modeButtonActive]}
                            onPress={() => setMode('execute')}
                        >
                            <Text style={[styles.modeText, mode === 'execute' && styles.modeTextActive]}>{t('taskManager.execute')}</Text>
                            <Text style={styles.modeHint}>{t('taskManager.executeHint')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[styles.modeButton, mode === 'plan' && styles.modeButtonActive]}
                            onPress={() => setMode('plan')}
                        >
                            <Text style={[styles.modeText, mode === 'plan' && styles.modeTextActive]}>{t('taskManager.plan')}</Text>
                            <Text style={styles.modeHint}>{t('taskManager.planHint')}</Text>
                        </TouchableOpacity>
                    </View>

                    {/* Yolo mode */}
                    <TouchableOpacity style={styles.yoloRow} onPress={() => setYolo(!yolo)}>
                        <View style={[styles.yoloCheck, yolo && styles.yoloCheckActive]}>
                            {yolo && <Text style={styles.yoloCheckMark}>✓</Text>}
                        </View>
                        <View>
                            <Text style={styles.yoloLabel}>{t('taskManager.yoloMode')}</Text>
                            <Text style={styles.modeHint}>{t('taskManager.yoloHint')}</Text>
                        </View>
                    </TouchableOpacity>

                    {/* Prompt */}
                    <Text style={styles.label}>{t('taskManager.taskPrompt')}</Text>
                    <TextInput
                        style={[styles.input, styles.textArea]}
                        value={prompt}
                        onChangeText={setPrompt}
                        placeholder={t('taskManager.taskPromptPlaceholder')}
                        multiline
                        numberOfLines={5}
                        autoFocus
                    />

                    {/* Actions */}
                    <View style={styles.actions}>
                        <TouchableOpacity onPress={onClose}>
                            <Text style={styles.cancelText}>{t('common.cancel')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[styles.createButton, !canCreate && { opacity: 0.5 }]}
                            onPress={handleCreate}
                            disabled={!canCreate || loading}
                        >
                            <Text style={styles.createText}>
                                {loading ? t('taskManager.creating') : mode === 'plan' ? t('taskManager.createPlan') : t('taskManager.createTask')}
                            </Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </Pressable>
        </Modal>
    );
});

const styles = StyleSheet.create((theme) => ({
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center' },
    modal: { backgroundColor: theme.colors.surface, borderRadius: 12, padding: 24, width: 520, maxWidth: '90%' as any, maxHeight: '85%' as any },
    modalTitle: { fontSize: 20, fontWeight: '700', color: theme.colors.text, marginBottom: 4 },
    modalSubtitle: { fontSize: 13, color: theme.colors.textSecondary, marginBottom: 16 },
    label: { fontSize: 13, fontWeight: '600', color: theme.colors.textSecondary, marginBottom: 6, marginTop: 12 },
    agentList: { flexDirection: 'row', marginBottom: 4 },
    agentChip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: theme.colors.groupped.background, marginRight: 8, alignItems: 'center' },
    agentChipActive: { backgroundColor: theme.colors.textLink },
    agentChipDimmed: { opacity: 0.5 },
    agentChipText: { fontSize: 13, color: theme.colors.text, fontWeight: '500' },
    agentChipTextActive: { color: '#fff' },
    agentChipType: { fontSize: 10, color: theme.colors.textSecondary, marginTop: 2 },
    modeRow: { flexDirection: 'row', gap: 10 },
    modeButton: { flex: 1, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.divider, backgroundColor: theme.colors.groupped.background },
    modeButtonActive: { borderColor: theme.colors.textLink, backgroundColor: theme.colors.surface },
    modeText: { fontSize: 14, fontWeight: '600', color: theme.colors.text, marginBottom: 2 },
    modeTextActive: { color: theme.colors.textLink },
    modeHint: { fontSize: 11, color: theme.colors.textSecondary },
    yoloRow: { flexDirection: 'row', alignItems: 'center', marginTop: 14, padding: 10, borderRadius: 8, backgroundColor: '#fff8e1', borderWidth: 1, borderColor: '#ffe082' },
    yoloCheck: { width: 20, height: 20, borderRadius: 4, borderWidth: 2, borderColor: theme.colors.divider, marginRight: 10, alignItems: 'center', justifyContent: 'center' },
    yoloCheckActive: { borderColor: '#f57c00', backgroundColor: '#f57c00' },
    yoloCheckMark: { color: '#fff', fontSize: 12, fontWeight: '700' },
    yoloLabel: { fontSize: 13, fontWeight: '600', color: '#e65100' },
    input: { borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: theme.colors.text, backgroundColor: theme.colors.groupped.background },
    textArea: { minHeight: 100, textAlignVertical: 'top' },
    actions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 20, gap: 12 },
    cancelText: { fontSize: 14, color: theme.colors.textSecondary, paddingVertical: 10 },
    createButton: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8, backgroundColor: theme.colors.textLink },
    createText: { fontSize: 14, color: '#fff', fontWeight: '600' },
}));
