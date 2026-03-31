import React, { memo, useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, TextInput, Pressable, Modal } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useTaskManagerStore, useTaskManagerActions } from '@/hooks/useTaskManager';
import { ProjectConfig } from '@/sync/apiProjects';
import { TaskConfig } from '@/sync/apiTasks';
import { MachineInfo } from '@/sync/apiMachinesRest';
import { AgentConfig } from '@/sync/apiAgents';
import { NewTaskModalWeb } from './NewTaskModalWeb';
import { t } from '@/text';

const CLI_TO_AGENT_TYPE: Record<string, string> = {
    claude: 'claude-code',
    codex: 'codex',
    gemini: 'gemini',
    openclaw: 'openclaw',
};

const AGENT_MODELS: Record<string, string[]> = {
    'claude-code': ['claude-sonnet-4-20250514', 'claude-opus-4-20250115'],
    'codex': ['o3', 'o4-mini'],
    'gemini': ['gemini-2.5-pro', 'gemini-2.5-flash'],
    'openclaw': ['default'],
};

function agentEmoji(type: string): string {
    switch (type) {
        case 'claude-code': return 'C';
        case 'codex': return 'X';
        case 'gemini': return 'G';
        case 'openclaw': return 'O';
        default: return 'A';
    }
}

function formatTimeAgo(date: Date): string {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return t('time.justNow');
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return t('time.minutesAgo', { count: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('time.hoursAgo', { count: hours });
    return t('sessionHistory.daysAgo', { count: Math.floor(hours / 24) });
}

export const TaskManagerSidebar = memo(function TaskManagerSidebar() {
    const { theme } = useUnistyles();
    const projects = useTaskManagerStore(s => s.projects);
    const agents = useTaskManagerStore(s => s.agents);
    const selectedProjectId = useTaskManagerStore(s => s.selectedProjectId);
    const tasks = useTaskManagerStore(s => s.tasks);
    const selectedTaskId = useTaskManagerStore(s => s.selectedTaskId);
    const machines = useTaskManagerStore(s => s.machines);

    const { loadTasks, addAgent, removeAgent, addProject, editProject, removeProject } = useTaskManagerActions();
    const selectProject = useTaskManagerStore(s => s.selectProject);
    const selectTask = useTaskManagerStore(s => s.selectTask);

    const [showNewTask, setShowNewTask] = useState(false);
    const [showNewAgent, setShowNewAgent] = useState(false);
    const [showNewProject, setShowNewProject] = useState(false);
    const [editingProject, setEditingProject] = useState<ProjectConfig | null>(null);

    const selectedProject = projects.find(p => p.id === selectedProjectId);

    const handleSelectProject = useCallback((id: string) => {
        selectProject(id);
        loadTasks(id);
    }, [selectProject, loadTasks]);

    // Load tasks when selected project changes
    useEffect(() => {
        if (selectedProjectId) {
            loadTasks(selectedProjectId);
        }
    }, [selectedProjectId]);

    return (
        <View style={styles.container}>
            <ScrollView style={styles.scrollArea}>
                {/* Machines */}
                <View style={styles.section}>
                    <Text style={styles.sectionLabel}>{t('taskManager.machines')}</Text>
                    {machines.length === 0 ? (
                        <Text style={styles.dimText}>{t('taskManager.noMachines')}</Text>
                    ) : (
                        machines.map(m => <MachineItem key={m.id} machine={m} />)
                    )}
                </View>

                {/* Agents */}
                <View style={styles.section}>
                    <View style={styles.sectionHeader}>
                        <Text style={styles.sectionLabel}>{t('taskManager.agents')}</Text>
                        <TouchableOpacity onPress={() => setShowNewAgent(true)}>
                            <Text style={styles.addLink}>+</Text>
                        </TouchableOpacity>
                    </View>
                    {agents.length === 0 ? (
                        <Text style={styles.dimText}>{t('taskManager.noAgents')}</Text>
                    ) : (
                        agents.map(a => (
                            <AgentItem key={a.id} agent={a} onDelete={() => removeAgent(a.id)} />
                        ))
                    )}
                </View>

                {/* Projects */}
                <View style={styles.section}>
                    <View style={styles.sectionHeader}>
                        <Text style={styles.sectionLabel}>{t('taskManager.projects')}</Text>
                        <TouchableOpacity onPress={() => setShowNewProject(true)}>
                            <Text style={styles.addLink}>+</Text>
                        </TouchableOpacity>
                    </View>
                    {projects.map(p => (
                        <TouchableOpacity
                            key={p.id}
                            style={[styles.projectRow, selectedProjectId === p.id && styles.projectRowActive]}
                            onPress={() => handleSelectProject(p.id)}
                        >
                            <View style={styles.projectRowLeft}>
                                <Text style={[styles.projectName, selectedProjectId === p.id && styles.projectNameActive]} numberOfLines={1}>
                                    {p.name}
                                </Text>
                                {p.githubUrl && (
                                    <Text style={styles.projectGithub} numberOfLines={1}>{p.githubUrl.replace(/^https?:\/\/(www\.)?github\.com\//, '')}</Text>
                                )}
                            </View>
                            <TouchableOpacity onPress={() => setEditingProject(p)} style={{ padding: 4 }}>
                                <Text style={{ color: theme.colors.textSecondary, fontSize: 14 }}>...</Text>
                            </TouchableOpacity>
                        </TouchableOpacity>
                    ))}
                    {projects.length === 0 && (
                        <Text style={styles.dimText}>{t('taskManager.noProjects')}</Text>
                    )}
                </View>

                {/* Tasks */}
                {selectedProject && (
                    <View style={styles.section}>
                        <View style={styles.sectionHeader}>
                            <Text style={styles.sectionLabel}>{t('taskManager.tasks')}</Text>
                            <TouchableOpacity style={styles.newButton} onPress={() => setShowNewTask(true)}>
                                <Text style={styles.newButtonText}>+ {t('taskManager.new')}</Text>
                            </TouchableOpacity>
                        </View>
                        {tasks.map(tsk => (
                            <TaskItem
                                key={tsk.id}
                                task={tsk}
                                selected={selectedTaskId === tsk.id}
                                onPress={() => selectTask(tsk.id)}
                            />
                        ))}
                        {tasks.length === 0 && (
                            <Text style={styles.dimText}>{t('taskManager.noTasks')}</Text>
                        )}
                    </View>
                )}
            </ScrollView>

            {/* Modals */}
            {showNewTask && selectedProject && (
                <NewTaskModalWeb project={selectedProject} onClose={() => setShowNewTask(false)} />
            )}
            {showNewAgent && (
                <QuickAgentModal
                    onClose={() => setShowNewAgent(false)}
                    onSave={async (data) => { await addAgent(data); setShowNewAgent(false); }}
                />
            )}
            {(showNewProject || editingProject) && (
                <ProjectModal
                    project={editingProject}
                    onClose={() => { setShowNewProject(false); setEditingProject(null); }}
                    onSave={async (data) => {
                        if (editingProject) {
                            await editProject(editingProject.id, data);
                        } else {
                            const p = await addProject(data);
                            if (p) handleSelectProject(p.id);
                        }
                        setShowNewProject(false);
                        setEditingProject(null);
                    }}
                    onDelete={editingProject ? async () => {
                        await removeProject(editingProject.id);
                        setEditingProject(null);
                    } : undefined}
                />
            )}
        </View>
    );
});

// ---- Agent item ----

const AgentItem = memo(function AgentItem({ agent, onDelete }: { agent: AgentConfig; onDelete: () => void }) {
    const { theme } = useUnistyles();
    return (
        <View style={styles.agentItem}>
            <View style={styles.agentIcon}>
                <Text style={styles.agentIconText}>{agentEmoji(agent.agentType)}</Text>
            </View>
            <View style={styles.agentInfo}>
                <Text style={styles.agentName} numberOfLines={1}>{agent.name}</Text>
                <Text style={styles.subText}>{agent.agentType}</Text>
            </View>
            <TouchableOpacity onPress={onDelete} style={{ padding: 4 }}>
                <Text style={{ fontSize: 16, color: theme.colors.textSecondary, fontWeight: '700' }}>x</Text>
            </TouchableOpacity>
        </View>
    );
});

// ---- Machine item ----

const MachineItem = memo(function MachineItem({ machine }: { machine: MachineInfo }) {
    const { theme } = useUnistyles();
    const { renameMachine } = useTaskManagerActions();
    const [editing, setEditing] = useState(false);
    const [editName, setEditName] = useState('');

    const isOnline = machine.active;
    const lastSeen = new Date(machine.activeAt);
    const timeAgo = formatTimeAgo(lastSeen);
    const hi = machine.hostInfo;
    const label = machine.displayName || hi?.hostname || machine.id.slice(0, 8);

    const handleRename = useCallback(async () => {
        const trimmed = editName.trim();
        if (trimmed && trimmed !== machine.displayName) {
            await renameMachine(machine.id, trimmed);
        }
        setEditing(false);
    }, [editName, machine.id, machine.displayName]);

    return (
        <View style={styles.machineItem}>
            <View style={[styles.dot, { backgroundColor: isOnline ? theme.colors.status.connected : theme.colors.textSecondary }]} />
            <View style={styles.machineInfo}>
                {editing ? (
                    <TextInput
                        style={styles.machineNameInput}
                        value={editName}
                        onChangeText={setEditName}
                        onBlur={handleRename}
                        onSubmitEditing={handleRename}
                        autoFocus
                    />
                ) : (
                    <Pressable onPress={() => { setEditName(label); setEditing(true); }}>
                        <Text style={styles.machineName} numberOfLines={1}>{label}</Text>
                    </Pressable>
                )}
                <Text style={styles.subText}>
                    {isOnline ? t('status.online') : `${t('machine.lastSeen')} ${timeAgo}`}
                    {hi?.platform ? ` · ${hi.platform}/${hi.arch || ''}` : ''}
                    {hi?.ip ? ` · ${hi.ip}` : ''}
                </Text>
                {hi?.workspaceRoot && (
                    <Text style={styles.subText} numberOfLines={1}>Workspace: {hi.workspaceRoot}</Text>
                )}
                {hi?.agents && hi.agents.length > 0 && (
                    <View style={styles.tagRow}>
                        {hi.agents.map(a => <Text key={a} style={styles.tag}>{a}</Text>)}
                    </View>
                )}
            </View>
        </View>
    );
});

// ---- Task item ----

const TaskItem = memo(function TaskItem({ task, selected, onPress }: {
    task: TaskConfig; selected: boolean; onPress: () => void;
}) {
    const { theme } = useUnistyles();
    const statusColors: Record<string, string> = {
        running: theme.colors.status.connected,
        waiting_for_permission: theme.colors.status.connecting,
        done: theme.colors.textSecondary,
        failed: theme.colors.status.error,
    };
    return (
        <TouchableOpacity style={[styles.taskItem, selected && styles.taskItemActive]} onPress={onPress}>
            <View style={styles.taskItemHeader}>
                <View style={[styles.dot, { backgroundColor: statusColors[task.status] || theme.colors.textSecondary }]} />
                <Text style={styles.subText} numberOfLines={1}>{task.agent.name}</Text>
            </View>
            <Text style={styles.taskTitle} numberOfLines={2}>{task.title}</Text>
            <Text style={styles.taskStatus}>{task.status.replace(/_/g, ' ')}</Text>
            {task.error && <Text style={styles.taskError} numberOfLines={1}>{task.error}</Text>}
        </TouchableOpacity>
    );
});

// ---- Quick agent creation modal ----

const QuickAgentModal = memo(function QuickAgentModal({ onClose, onSave }: {
    onClose: () => void;
    onSave: (data: { name: string; agentType: string; model?: string }) => Promise<void>;
}) {
    const { theme } = useUnistyles();
    const machines = useTaskManagerStore(s => s.machines);
    const onlineMachines = machines.filter(m => m.active);

    const [selectedMachineId, setSelectedMachineId] = useState<string | null>(
        onlineMachines.length === 1 ? onlineMachines[0].id : null
    );
    const [agentType, setAgentType] = useState<string | null>(null);
    const [model, setModel] = useState<string | null>(null);
    const [name, setName] = useState('');
    const [loading, setLoading] = useState(false);

    const selectedMachine = onlineMachines.find(m => m.id === selectedMachineId);
    const availableAgentTypes = (selectedMachine?.hostInfo?.agents || [])
        .map(cli => CLI_TO_AGENT_TYPE[cli])
        .filter(Boolean);
    const availableModels = agentType ? (AGENT_MODELS[agentType] || []) : [];

    const handleSelectMachine = useCallback((id: string) => {
        setSelectedMachineId(id);
        setAgentType(null);
        setModel(null);
    }, []);

    const handleSelectType = useCallback((tp: string) => {
        setAgentType(tp);
        setModel(AGENT_MODELS[tp]?.[0] || null);
    }, []);

    const handleSave = useCallback(async () => {
        if (!name.trim() || !agentType) return;
        setLoading(true);
        try {
            await onSave({
                name: name.trim(),
                agentType,
                ...(model && model !== 'default' ? { model } : {}),
            });
        } finally { setLoading(false); }
    }, [name, agentType, model]);

    useEffect(() => {
        if (selectedMachineId && availableAgentTypes.length === 1 && !agentType) {
            handleSelectType(availableAgentTypes[0]);
        }
    }, [selectedMachineId, availableAgentTypes.length]);

    const canCreate = name.trim() && agentType && model;

    return (
        <Modal transparent animationType="fade" onRequestClose={onClose}>
            <Pressable style={styles.overlay} onPress={(e) => { if (e.target === e.currentTarget) onClose(); }}>
                <View style={styles.modal}>
                    <Text style={styles.modalTitle}>{t('taskManager.newAgent')}</Text>

                    <Text style={styles.label}>{t('taskManager.machine')}</Text>
                    {onlineMachines.length === 0 ? (
                        <Text style={styles.dimText}>{t('taskManager.noMachinesOnline')}</Text>
                    ) : (
                        <View style={styles.chipRow}>
                            {onlineMachines.map(m => {
                                const mLabel = m.displayName || m.hostInfo?.hostname || m.id.slice(0, 8);
                                return (
                                    <TouchableOpacity
                                        key={m.id}
                                        style={[styles.chip, selectedMachineId === m.id && styles.chipActive]}
                                        onPress={() => handleSelectMachine(m.id)}
                                    >
                                        <Text style={[styles.chipText, selectedMachineId === m.id && styles.chipTextActive]}>
                                            {mLabel}
                                        </Text>
                                    </TouchableOpacity>
                                );
                            })}
                        </View>
                    )}

                    {selectedMachineId && (
                        <>
                            <Text style={styles.label}>{t('taskManager.agentType')}</Text>
                            {availableAgentTypes.length === 0 ? (
                                <Text style={styles.dimText}>{t('taskManager.noAgentsOnMachine')}</Text>
                            ) : (
                                <View style={styles.chipRow}>
                                    {availableAgentTypes.map(tp => (
                                        <TouchableOpacity
                                            key={tp}
                                            style={[styles.chip, agentType === tp && styles.chipActive]}
                                            onPress={() => handleSelectType(tp)}
                                        >
                                            <Text style={[styles.chipText, agentType === tp && styles.chipTextActive]}>{tp}</Text>
                                        </TouchableOpacity>
                                    ))}
                                </View>
                            )}
                        </>
                    )}

                    {agentType && availableModels.length > 0 && (
                        <>
                            <Text style={styles.label}>{t('taskManager.model')}</Text>
                            <View style={styles.chipRow}>
                                {availableModels.map(m => (
                                    <TouchableOpacity
                                        key={m}
                                        style={[styles.chip, model === m && styles.chipActive]}
                                        onPress={() => setModel(m)}
                                    >
                                        <Text style={[styles.chipText, model === m && styles.chipTextActive]}>{m}</Text>
                                    </TouchableOpacity>
                                ))}
                            </View>
                        </>
                    )}

                    {agentType && (
                        <>
                            <Text style={styles.label}>{t('taskManager.name')}</Text>
                            <TextInput
                                style={styles.input}
                                value={name}
                                onChangeText={setName}
                                placeholder={`e.g. ${agentType} reviewer`}
                            />
                        </>
                    )}

                    <View style={styles.modalActions}>
                        <TouchableOpacity onPress={onClose}>
                            <Text style={styles.cancelText}>{t('common.cancel')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[styles.newButton, !canCreate && { opacity: 0.5 }]}
                            onPress={handleSave}
                            disabled={!canCreate || loading}
                        >
                            <Text style={styles.newButtonText}>{loading ? t('taskManager.creating') : t('common.create')}</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </Pressable>
        </Modal>
    );
});

// ---- Project modal ----

const ProjectModal = memo(function ProjectModal({ project, onClose, onSave, onDelete }: {
    project: ProjectConfig | null;
    onClose: () => void;
    onSave: (data: { name: string; description?: string | null; githubUrl?: string | null }) => Promise<void>;
    onDelete?: () => Promise<void>;
}) {
    const { theme } = useUnistyles();
    const [name, setName] = useState(project?.name || '');
    const [description, setDescription] = useState(project?.description || '');
    const [githubUrl, setGithubUrl] = useState(project?.githubUrl || '');
    const [loading, setLoading] = useState(false);

    const handleSave = useCallback(async () => {
        if (!name.trim()) return;
        setLoading(true);
        try {
            await onSave({
                name: name.trim(),
                description: description.trim() || null,
                githubUrl: githubUrl.trim() || null,
            });
        } finally { setLoading(false); }
    }, [name, description, githubUrl]);

    return (
        <Modal transparent animationType="fade" onRequestClose={onClose}>
            <Pressable style={styles.overlay} onPress={(e) => { if (e.target === e.currentTarget) onClose(); }}>
                <View style={styles.modal}>
                    <Text style={styles.modalTitle}>
                        {project ? t('taskManager.editProject') : t('taskManager.newProject')}
                    </Text>

                    <Text style={styles.label}>{t('taskManager.name')}</Text>
                    <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="e.g. my-app" autoFocus />

                    <Text style={styles.label}>{t('taskManager.githubRepo')}</Text>
                    <TextInput style={styles.input} value={githubUrl} onChangeText={setGithubUrl} placeholder="https://github.com/org/repo" />

                    <Text style={styles.label}>{t('taskManager.description')}</Text>
                    <TextInput style={styles.input} value={description} onChangeText={setDescription} placeholder={t('taskManager.descriptionPlaceholder')} />

                    <View style={styles.modalActions}>
                        {onDelete && (
                            <TouchableOpacity onPress={onDelete} style={{ marginRight: 'auto' as any }}>
                                <Text style={{ fontSize: 14, color: theme.colors.status.error }}>{t('common.delete')}</Text>
                            </TouchableOpacity>
                        )}
                        <TouchableOpacity onPress={onClose}>
                            <Text style={styles.cancelText}>{t('common.cancel')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[styles.newButton, (!name.trim() || loading) && { opacity: 0.5 }]}
                            onPress={handleSave}
                            disabled={!name.trim() || loading}
                        >
                            <Text style={styles.newButtonText}>
                                {loading ? t('taskManager.saving') : project ? t('common.save') : t('common.create')}
                            </Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </Pressable>
        </Modal>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: { flex: 1, flexDirection: 'column' },
    scrollArea: { flex: 1 },
    section: { padding: 16, borderBottomWidth: 1, borderBottomColor: theme.colors.divider },
    sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
    sectionLabel: { fontSize: 12, fontWeight: '600', color: theme.colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
    addLink: { fontSize: 18, color: theme.colors.textLink, fontWeight: '600', marginBottom: 8, paddingHorizontal: 4 },
    dimText: { fontSize: 12, color: theme.colors.textSecondary, fontStyle: 'italic' },
    subText: { fontSize: 11, color: theme.colors.textSecondary },

    // Agents
    agentItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
    agentIcon: { width: 28, height: 28, borderRadius: 6, backgroundColor: theme.colors.groupped.background, alignItems: 'center', justifyContent: 'center', marginRight: 10 },
    agentIconText: { fontSize: 13, fontWeight: '700', color: theme.colors.textLink },
    agentInfo: { flex: 1 },
    agentName: { fontSize: 13, fontWeight: '500', color: theme.colors.text },

    // Machines
    machineItem: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 4 },
    dot: { width: 8, height: 8, borderRadius: 4, marginRight: 8, marginTop: 4 },
    machineInfo: { flex: 1 },
    machineName: { fontSize: 13, fontWeight: '500', color: theme.colors.text, cursor: 'pointer' as any },
    machineNameInput: { fontSize: 13, fontWeight: '500', color: theme.colors.text, borderBottomWidth: 1, borderBottomColor: theme.colors.textLink, paddingVertical: 0 },
    tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 3 },
    tag: { fontSize: 10, color: theme.colors.textLink, backgroundColor: theme.colors.groupped.background, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4, fontWeight: '500' },

    // Projects
    projectRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, paddingHorizontal: 8, borderRadius: 8, marginVertical: 1 },
    projectRowActive: { backgroundColor: theme.colors.groupped.background },
    projectRowLeft: { flex: 1 },
    projectName: { fontSize: 13, fontWeight: '500', color: theme.colors.text },
    projectNameActive: { color: theme.colors.textLink },
    projectGithub: { fontSize: 11, color: theme.colors.textSecondary, marginTop: 1 },

    // Chips
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, backgroundColor: theme.colors.groupped.background },
    chipActive: { backgroundColor: theme.colors.textLink },
    chipText: { fontSize: 13, color: theme.colors.text },
    chipTextActive: { color: '#fff' },

    // Tasks
    taskItem: { padding: 12, marginVertical: 2, borderRadius: 8 },
    taskItemActive: { backgroundColor: theme.colors.groupped.background },
    taskItemHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
    taskTitle: { fontSize: 14, color: theme.colors.text, fontWeight: '500', marginBottom: 2 },
    taskStatus: { fontSize: 11, color: theme.colors.textSecondary, textTransform: 'capitalize' },
    taskError: { fontSize: 11, color: theme.colors.status.error, marginTop: 2 },

    // Buttons
    newButton: { paddingHorizontal: 12, paddingVertical: 4, borderRadius: 12, backgroundColor: theme.colors.textLink },
    newButtonText: { color: '#fff', fontSize: 13, fontWeight: '600' },

    // Modal
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center' },
    modal: { backgroundColor: theme.colors.surface, borderRadius: 12, padding: 24, width: 420, maxWidth: '90%' as any },
    modalTitle: { fontSize: 20, fontWeight: '700', color: theme.colors.text, marginBottom: 16 },
    modalActions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 20, gap: 12, alignItems: 'center' },
    label: { fontSize: 13, fontWeight: '600', color: theme.colors.textSecondary, marginBottom: 6, marginTop: 12 },
    input: { borderWidth: 1, borderColor: theme.colors.divider, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: theme.colors.text, backgroundColor: theme.colors.groupped.background },
    cancelText: { fontSize: 14, color: theme.colors.textSecondary },
}));
