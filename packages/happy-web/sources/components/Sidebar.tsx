import React, { memo, useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, TextInput, Pressable, Modal } from 'react-native';
import { useStore } from '@/store/store';
import { NewTaskModal } from './NewTaskModal';
import { ProjectConfig } from '@/api/projects';
import { TaskConfig } from '@/api/tasks';
import { MachineInfo } from '@/api/machines';
import { AgentConfig } from '@/api/agents';

export const Sidebar = memo(function Sidebar() {
    const projects = useStore(s => s.projects);
    const agents = useStore(s => s.agents);
    const selectedProjectId = useStore(s => s.selectedProjectId);
    const selectProject = useStore(s => s.selectProject);
    const addProject = useStore(s => s.addProject);
    const editProject = useStore(s => s.editProject);
    const removeProject = useStore(s => s.removeProject);
    const tasks = useStore(s => s.tasks);
    const selectedTaskId = useStore(s => s.selectedTaskId);
    const selectTask = useStore(s => s.selectTask);
    const machines = useStore(s => s.machines);
    const loadMachines = useStore(s => s.loadMachines);
    const addAgent = useStore(s => s.addAgent);
    const removeAgent = useStore(s => s.removeAgent);
    const [showNewTask, setShowNewTask] = useState(false);
    const [showNewAgent, setShowNewAgent] = useState(false);
    const [showNewProject, setShowNewProject] = useState(false);
    const [editingProject, setEditingProject] = useState<ProjectConfig | null>(null);

    useEffect(() => {
        loadMachines();
        const interval = setInterval(loadMachines, 30000);
        return () => clearInterval(interval);
    }, []);

    const selectedProject = projects.find(p => p.id === selectedProjectId);

    return (
        <View style={styles.container}>
            <ScrollView style={styles.scrollArea}>
                {/* Machines */}
                <View style={styles.section}>
                    <Text style={styles.sectionLabel}>Machines</Text>
                    {machines.length === 0 ? (
                        <Text style={styles.dimText}>No machines connected</Text>
                    ) : (
                        machines.map(m => <MachineItem key={m.id} machine={m} />)
                    )}
                </View>

                {/* Agents */}
                <View style={styles.section}>
                    <View style={styles.sectionHeader}>
                        <Text style={styles.sectionLabel}>Agents</Text>
                        <TouchableOpacity onPress={() => setShowNewAgent(true)}>
                            <Text style={styles.addLink}>+</Text>
                        </TouchableOpacity>
                    </View>
                    {agents.length === 0 ? (
                        <Text style={styles.dimText}>No agents configured</Text>
                    ) : (
                        agents.map(a => (
                            <AgentItem key={a.id} agent={a} onDelete={() => removeAgent(a.id)} />
                        ))
                    )}
                </View>

                {/* Projects */}
                <View style={styles.section}>
                    <View style={styles.sectionHeader}>
                        <Text style={styles.sectionLabel}>Projects</Text>
                        <TouchableOpacity onPress={() => setShowNewProject(true)}>
                            <Text style={styles.addLink}>+</Text>
                        </TouchableOpacity>
                    </View>
                    {projects.map(p => (
                        <TouchableOpacity
                            key={p.id}
                            style={[styles.projectRow, selectedProjectId === p.id && styles.projectRowActive]}
                            onPress={() => selectProject(p.id)}
                            onLongPress={() => setEditingProject(p)}
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
                                <Text style={{ color: '#ccc', fontSize: 14 }}>...</Text>
                            </TouchableOpacity>
                        </TouchableOpacity>
                    ))}
                    {projects.length === 0 && (
                        <Text style={styles.dimText}>No projects yet</Text>
                    )}
                </View>

                {/* Tasks */}
                {selectedProject && (
                    <View style={styles.section}>
                        <View style={styles.sectionHeader}>
                            <Text style={styles.sectionLabel}>Tasks</Text>
                            <TouchableOpacity style={styles.newButton} onPress={() => setShowNewTask(true)}>
                                <Text style={styles.newButtonText}>+ New</Text>
                            </TouchableOpacity>
                        </View>
                        {tasks.map(t => (
                            <TaskItem
                                key={t.id}
                                task={t}
                                selected={selectedTaskId === t.id}
                                onPress={() => selectTask(t.id)}
                            />
                        ))}
                        {tasks.length === 0 && (
                            <Text style={styles.dimText}>No tasks yet</Text>
                        )}
                    </View>
                )}
            </ScrollView>

            {/* Modals */}
            {showNewTask && selectedProject && (
                <NewTaskModal project={selectedProject} onClose={() => setShowNewTask(false)} />
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
                            selectProject(p.id);
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
    return (
        <View style={styles.agentItem}>
            <View style={styles.agentIcon}>
                <Text style={styles.agentIconText}>{agentEmoji(agent.agentType)}</Text>
            </View>
            <View style={styles.agentInfo}>
                <Text style={styles.agentName} numberOfLines={1}>{agent.name}</Text>
                <Text style={styles.agentType}>{agent.agentType}</Text>
            </View>
            <TouchableOpacity onPress={onDelete} style={styles.agentDelete}>
                <Text style={styles.agentDeleteText}>×</Text>
            </TouchableOpacity>
        </View>
    );
});

function agentEmoji(type: string): string {
    switch (type) {
        case 'claude-code': return 'C';
        case 'codex': return 'X';
        case 'gemini': return 'G';
        case 'openclaw': return 'O';
        default: return 'A';
    }
}

// ---- Agent creation constants ----

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

// ---- Quick agent creation modal ----

const QuickAgentModal = memo(function QuickAgentModal({ onClose, onSave }: {
    onClose: () => void;
    onSave: (data: { name: string; agentType: string; model?: string }) => Promise<void>;
}) {
    const machines = useStore(s => s.machines);
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

    const handleSelectType = useCallback((t: string) => {
        setAgentType(t);
        setModel(AGENT_MODELS[t]?.[0] || null);
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

    // Auto-select agent type if machine has exactly one
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
                    <Text style={styles.modalTitle}>New Agent</Text>

                    {/* Step 1: Machine */}
                    <Text style={styles.label}>Machine</Text>
                    {onlineMachines.length === 0 ? (
                        <Text style={styles.dimText}>No machines online. Start a daemon first.</Text>
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

                    {/* Step 2: Agent Type */}
                    {selectedMachineId && (
                        <>
                            <Text style={styles.label}>Agent Type</Text>
                            {availableAgentTypes.length === 0 ? (
                                <Text style={styles.dimText}>No code agents detected on this machine.</Text>
                            ) : (
                                <View style={styles.chipRow}>
                                    {availableAgentTypes.map(t => (
                                        <TouchableOpacity
                                            key={t}
                                            style={[styles.chip, agentType === t && styles.chipActive]}
                                            onPress={() => handleSelectType(t)}
                                        >
                                            <Text style={[styles.chipText, agentType === t && styles.chipTextActive]}>{t}</Text>
                                        </TouchableOpacity>
                                    ))}
                                </View>
                            )}
                        </>
                    )}

                    {/* Step 3: Model */}
                    {agentType && availableModels.length > 0 && (
                        <>
                            <Text style={styles.label}>Model</Text>
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

                    {/* Step 4: Name */}
                    {agentType && (
                        <>
                            <Text style={styles.label}>Name</Text>
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
                            <Text style={styles.cancelText}>Cancel</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[styles.newButton, !canCreate && { opacity: 0.5 }]}
                            onPress={handleSave}
                            disabled={!canCreate || loading}
                        >
                            <Text style={styles.newButtonText}>{loading ? 'Creating...' : 'Create'}</Text>
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
                    <Text style={styles.modalTitle}>{project ? 'Edit Project' : 'New Project'}</Text>

                    <Text style={styles.label}>Name</Text>
                    <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="e.g. my-app" autoFocus />

                    <Text style={styles.label}>GitHub Repository</Text>
                    <TextInput style={styles.input} value={githubUrl} onChangeText={setGithubUrl} placeholder="https://github.com/org/repo" />

                    <Text style={styles.label}>Description</Text>
                    <TextInput style={styles.input} value={description} onChangeText={setDescription} placeholder="What is this project about?" />

                    <View style={styles.modalActions}>
                        {onDelete && (
                            <TouchableOpacity onPress={onDelete} style={{ marginRight: 'auto' as any }}>
                                <Text style={{ fontSize: 14, color: '#d93025' }}>Delete</Text>
                            </TouchableOpacity>
                        )}
                        <TouchableOpacity onPress={onClose}>
                            <Text style={styles.cancelText}>Cancel</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[styles.newButton, (!name.trim() || loading) && { opacity: 0.5 }]}
                            onPress={handleSave}
                            disabled={!name.trim() || loading}
                        >
                            <Text style={styles.newButtonText}>{loading ? 'Saving...' : project ? 'Save' : 'Create'}</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </Pressable>
        </Modal>
    );
});

// ---- Machine item ----

const MachineItem = memo(function MachineItem({ machine }: { machine: MachineInfo }) {
    const renameMachine = useStore(s => s.renameMachine);
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
            <View style={[styles.dot, { backgroundColor: isOnline ? '#4caf50' : '#9e9e9e' }]} />
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
                    {isOnline ? 'Online' : `Last seen ${timeAgo}`}
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

function formatTimeAgo(date: Date): string {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

// ---- Task item ----

const TaskItem = memo(function TaskItem({ task, selected, onPress }: {
    task: TaskConfig; selected: boolean; onPress: () => void;
}) {
    const statusColors: Record<string, string> = {
        running: '#4caf50', waiting_for_permission: '#ff9800', done: '#9e9e9e', failed: '#f44336',
    };
    return (
        <TouchableOpacity style={[styles.taskItem, selected && styles.taskItemActive]} onPress={onPress}>
            <View style={styles.taskItemHeader}>
                <View style={[styles.dot, { backgroundColor: statusColors[task.status] || '#9e9e9e' }]} />
                <Text style={styles.subText} numberOfLines={1}>{task.agent.name}</Text>
            </View>
            <Text style={styles.taskTitle} numberOfLines={2}>{task.title}</Text>
            <Text style={styles.taskStatus}>{task.status.replace(/_/g, ' ')}</Text>
            {task.error && <Text style={styles.taskError} numberOfLines={1}>{task.error}</Text>}
        </TouchableOpacity>
    );
});

// ---- Styles ----

const styles = StyleSheet.create({
    container: { flex: 1, flexDirection: 'column' },
    scrollArea: { flex: 1 },
    section: { padding: 16, borderBottomWidth: 1, borderBottomColor: '#e0e0e0' },
    sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
    sectionLabel: { fontSize: 12, fontWeight: '600', color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
    addLink: { fontSize: 18, color: '#1a73e8', fontWeight: '600', marginBottom: 8, paddingHorizontal: 4 },
    dimText: { fontSize: 12, color: '#bbb', fontStyle: 'italic' },
    subText: { fontSize: 11, color: '#999' },

    // Agents
    agentItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
    agentIcon: { width: 28, height: 28, borderRadius: 6, backgroundColor: '#e8f0fe', alignItems: 'center', justifyContent: 'center', marginRight: 10 },
    agentIconText: { fontSize: 13, fontWeight: '700', color: '#1a73e8' },
    agentInfo: { flex: 1 },
    agentName: { fontSize: 13, fontWeight: '500', color: '#333' },
    agentType: { fontSize: 11, color: '#999' },
    agentDelete: { padding: 4 },
    agentDeleteText: { fontSize: 16, color: '#ccc', fontWeight: '700' },

    // Machines
    machineItem: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 4 },
    dot: { width: 8, height: 8, borderRadius: 4, marginRight: 8, marginTop: 4 },
    machineInfo: { flex: 1 },
    machineName: { fontSize: 13, fontWeight: '500', color: '#333', cursor: 'pointer' as any },
    machineNameInput: { fontSize: 13, fontWeight: '500', color: '#333', borderBottomWidth: 1, borderBottomColor: '#1a73e8', paddingVertical: 0 },
    tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 3 },
    tag: { fontSize: 10, color: '#1a73e8', backgroundColor: '#e8f0fe', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4, fontWeight: '500' },

    // Project rows
    projectRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, paddingHorizontal: 8, borderRadius: 8, marginVertical: 1 },
    projectRowActive: { backgroundColor: '#e8f0fe' },
    projectRowLeft: { flex: 1 },
    projectName: { fontSize: 13, fontWeight: '500', color: '#333' },
    projectNameActive: { color: '#1a73e8' },
    projectGithub: { fontSize: 11, color: '#999', marginTop: 1 },

    // Chips
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, backgroundColor: '#f0f0f0' },
    chipActive: { backgroundColor: '#1a73e8' },
    chipText: { fontSize: 13, color: '#333' },
    chipTextActive: { color: '#fff' },

    // Tasks
    taskItem: { padding: 12, marginVertical: 2, borderRadius: 8 },
    taskItemActive: { backgroundColor: '#e8f0fe' },
    taskItemHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
    taskTitle: { fontSize: 14, color: '#333', fontWeight: '500', marginBottom: 2 },
    taskStatus: { fontSize: 11, color: '#999', textTransform: 'capitalize' },
    taskError: { fontSize: 11, color: '#d93025', marginTop: 2 },

    // Buttons
    newButton: { paddingHorizontal: 12, paddingVertical: 4, borderRadius: 12, backgroundColor: '#1a73e8' },
    newButtonText: { color: '#fff', fontSize: 13, fontWeight: '600' },

    // Modal
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center' },
    modal: { backgroundColor: '#fff', borderRadius: 12, padding: 24, width: 420, maxWidth: '90%' as any },
    modalTitle: { fontSize: 20, fontWeight: '700', color: '#333', marginBottom: 16 },
    modalActions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 20, gap: 12, alignItems: 'center' },
    label: { fontSize: 13, fontWeight: '600', color: '#555', marginBottom: 6, marginTop: 12 },
    input: { borderWidth: 1, borderColor: '#ddd', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: '#333', backgroundColor: '#fafafa' },
    cancelText: { fontSize: 14, color: '#666' },
});
