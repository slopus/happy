import React, { memo, useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, TextInput, StyleSheet, Modal } from 'react-native';
import { useStore } from '@/store/store';
import { AgentConfig } from '@/api/agents';
import { ProjectConfig } from '@/api/projects';

const Settings = memo(function Settings() {
    const [tab, setTab] = useState<'agents' | 'projects'>('agents');

    return (
        <View style={styles.container}>
            {/* Tabs */}
            <View style={styles.tabs}>
                <TouchableOpacity
                    style={[styles.tab, tab === 'agents' && styles.tabActive]}
                    onPress={() => setTab('agents')}
                >
                    <Text style={[styles.tabText, tab === 'agents' && styles.tabTextActive]}>Agents</Text>
                </TouchableOpacity>
                <TouchableOpacity
                    style={[styles.tab, tab === 'projects' && styles.tabActive]}
                    onPress={() => setTab('projects')}
                >
                    <Text style={[styles.tabText, tab === 'projects' && styles.tabTextActive]}>Projects</Text>
                </TouchableOpacity>
            </View>

            {tab === 'agents' ? <AgentManager /> : <ProjectManager />}
        </View>
    );
});

export default Settings;

// ============ Agent Manager ============

const AgentManager = memo(function AgentManager() {
    const agents = useStore(s => s.agents);
    const loadAgents = useStore(s => s.loadAgents);
    const addAgent = useStore(s => s.addAgent);
    const editAgent = useStore(s => s.editAgent);
    const removeAgent = useStore(s => s.removeAgent);
    const [showForm, setShowForm] = useState(false);
    const [editingAgent, setEditingAgent] = useState<AgentConfig | null>(null);

    useEffect(() => { loadAgents(); }, []);

    const handleEdit = useCallback((agent: AgentConfig) => {
        setEditingAgent(agent);
        setShowForm(true);
    }, []);

    const handleNew = useCallback(() => {
        setEditingAgent(null);
        setShowForm(true);
    }, []);

    return (
        <ScrollView style={styles.content}>
            <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>Agent Configurations</Text>
                <TouchableOpacity style={styles.addButton} onPress={handleNew}>
                    <Text style={styles.addButtonText}>+ New Agent</Text>
                </TouchableOpacity>
            </View>

            {agents.map(agent => (
                <View key={agent.id} style={styles.card}>
                    <View style={styles.cardHeader}>
                        <Text style={styles.cardTitle}>{agent.name}</Text>
                        <Text style={styles.cardBadge}>{agent.agentType}</Text>
                    </View>
                    {agent.model && <Text style={styles.cardDetail}>Model: {agent.model}</Text>}
                    {agent.systemPrompt && (
                        <Text style={styles.cardDetail} numberOfLines={2}>
                            Prompt: {agent.systemPrompt}
                        </Text>
                    )}
                    {agent.permissionMode && <Text style={styles.cardDetail}>Permission: {agent.permissionMode}</Text>}
                    <View style={styles.cardActions}>
                        <TouchableOpacity onPress={() => handleEdit(agent)}>
                            <Text style={styles.linkText}>Edit</Text>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={() => removeAgent(agent.id)}>
                            <Text style={styles.dangerLink}>Delete</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            ))}

            {agents.length === 0 && (
                <Text style={styles.emptyText}>No agents configured. Create one to get started.</Text>
            )}

            {showForm && (
                <AgentForm
                    agent={editingAgent}
                    onClose={() => setShowForm(false)}
                    onSave={async (data) => {
                        if (editingAgent) {
                            await editAgent(editingAgent.id, data);
                        } else {
                            await addAgent(data as any);
                        }
                        setShowForm(false);
                    }}
                />
            )}
        </ScrollView>
    );
});

// ============ Agent Form Modal ============

const AgentForm = memo(function AgentForm({ agent, onClose, onSave }: {
    agent: AgentConfig | null;
    onClose: () => void;
    onSave: (data: any) => Promise<void>;
}) {
    const [name, setName] = useState(agent?.name || '');
    const [agentType, setAgentType] = useState(agent?.agentType || 'claude-code');
    const [model, setModel] = useState(agent?.model || '');
    const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt || '');
    const [permissionMode, setPermissionMode] = useState(agent?.permissionMode || '');
    const [loading, setLoading] = useState(false);

    const handleSave = useCallback(async () => {
        if (!name.trim() || !agentType.trim()) return;
        setLoading(true);
        try {
            await onSave({
                name: name.trim(),
                agentType: agentType.trim(),
                model: model.trim() || null,
                systemPrompt: systemPrompt.trim() || null,
                permissionMode: permissionMode.trim() || null,
            });
        } finally {
            setLoading(false);
        }
    }, [name, agentType, model, systemPrompt, permissionMode]);

    return (
        <Modal transparent animationType="fade" onRequestClose={onClose}>
            <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onClose}>
                <View style={styles.modal} onStartShouldSetResponder={() => true}>
                    <Text style={styles.modalTitle}>{agent ? 'Edit Agent' : 'New Agent'}</Text>

                    <Text style={styles.label}>Name *</Text>
                    <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="e.g. Code Reviewer" autoFocus />

                    <Text style={styles.label}>Type *</Text>
                    <View style={styles.typeRow}>
                        {['claude-code', 'codex', 'gemini', 'openclaw'].map(t => (
                            <TouchableOpacity
                                key={t}
                                style={[styles.typeChip, agentType === t && styles.typeChipActive]}
                                onPress={() => setAgentType(t)}
                            >
                                <Text style={[styles.typeChipText, agentType === t && styles.typeChipTextActive]}>{t}</Text>
                            </TouchableOpacity>
                        ))}
                    </View>

                    <Text style={styles.label}>Model</Text>
                    <TextInput style={styles.input} value={model} onChangeText={setModel} placeholder="e.g. claude-opus-4-6" />

                    <Text style={styles.label}>System Prompt</Text>
                    <TextInput
                        style={[styles.input, styles.textArea]}
                        value={systemPrompt}
                        onChangeText={setSystemPrompt}
                        placeholder="Instructions for the agent..."
                        multiline
                        numberOfLines={4}
                    />

                    <Text style={styles.label}>Permission Mode</Text>
                    <TextInput style={styles.input} value={permissionMode} onChangeText={setPermissionMode} placeholder="e.g. plan, readonly, full" />

                    <View style={styles.formActions}>
                        <TouchableOpacity style={styles.cancelButton} onPress={onClose}>
                            <Text style={styles.cancelText}>Cancel</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[styles.saveButton, (!name.trim() || loading) && styles.buttonDisabled]}
                            onPress={handleSave}
                            disabled={!name.trim() || loading}
                        >
                            <Text style={styles.saveText}>{loading ? 'Saving...' : 'Save'}</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </TouchableOpacity>
        </Modal>
    );
});

// ============ Project Manager ============

const ProjectManager = memo(function ProjectManager() {
    const projects = useStore(s => s.projects);
    const agents = useStore(s => s.agents);
    const loadProjects = useStore(s => s.loadProjects);
    const loadAgents = useStore(s => s.loadAgents);
    const addProject = useStore(s => s.addProject);
    const editProject = useStore(s => s.editProject);
    const removeProject = useStore(s => s.removeProject);
    const linkAgent = useStore(s => s.linkAgent);
    const unlinkAgent = useStore(s => s.unlinkAgent);
    const [showForm, setShowForm] = useState(false);
    const [editingProject, setEditingProject] = useState<ProjectConfig | null>(null);

    useEffect(() => {
        loadProjects();
        loadAgents();
    }, []);

    return (
        <ScrollView style={styles.content}>
            <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>Projects</Text>
                <TouchableOpacity style={styles.addButton} onPress={() => { setEditingProject(null); setShowForm(true); }}>
                    <Text style={styles.addButtonText}>+ New Project</Text>
                </TouchableOpacity>
            </View>

            {projects.map(project => (
                <View key={project.id} style={styles.card}>
                    <View style={styles.cardHeader}>
                        <Text style={styles.cardTitle}>{project.name}</Text>
                    </View>
                    {project.description && <Text style={styles.cardDetail}>{project.description}</Text>}
                    {project.workingDirectory && <Text style={styles.cardDetail}>Dir: {project.workingDirectory}</Text>}

                    {/* Linked agents */}
                    <Text style={[styles.label, { marginTop: 12 }]}>Agents:</Text>
                    <View style={styles.agentChips}>
                        {project.agents.map(a => (
                            <View key={a.id} style={styles.linkedAgent}>
                                <Text style={styles.linkedAgentText}>{a.name}</Text>
                                <TouchableOpacity onPress={() => unlinkAgent(project.id, a.id)}>
                                    <Text style={styles.removeAgentText}>×</Text>
                                </TouchableOpacity>
                            </View>
                        ))}
                        {/* Available agents to add */}
                        {agents
                            .filter(a => !project.agents.some(pa => pa.id === a.id))
                            .map(a => (
                                <TouchableOpacity
                                    key={a.id}
                                    style={styles.addAgentChip}
                                    onPress={() => linkAgent(project.id, a.id)}
                                >
                                    <Text style={styles.addAgentText}>+ {a.name}</Text>
                                </TouchableOpacity>
                            ))
                        }
                    </View>

                    <View style={styles.cardActions}>
                        <TouchableOpacity onPress={() => { setEditingProject(project); setShowForm(true); }}>
                            <Text style={styles.linkText}>Edit</Text>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={() => removeProject(project.id)}>
                            <Text style={styles.dangerLink}>Delete</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            ))}

            {projects.length === 0 && (
                <Text style={styles.emptyText}>No projects yet. Create one to get started.</Text>
            )}

            {showForm && (
                <ProjectForm
                    project={editingProject}
                    onClose={() => setShowForm(false)}
                    onSave={async (data) => {
                        if (editingProject) {
                            await editProject(editingProject.id, data);
                        } else {
                            await addProject(data as any);
                        }
                        setShowForm(false);
                    }}
                />
            )}
        </ScrollView>
    );
});

// ============ Project Form Modal ============

const ProjectForm = memo(function ProjectForm({ project, onClose, onSave }: {
    project: ProjectConfig | null;
    onClose: () => void;
    onSave: (data: any) => Promise<void>;
}) {
    const [name, setName] = useState(project?.name || '');
    const [description, setDescription] = useState(project?.description || '');
    const [workingDirectory, setWorkingDirectory] = useState(project?.workingDirectory || '');
    const [loading, setLoading] = useState(false);

    const handleSave = useCallback(async () => {
        if (!name.trim()) return;
        setLoading(true);
        try {
            await onSave({
                name: name.trim(),
                description: description.trim() || null,
                workingDirectory: workingDirectory.trim() || null,
            });
        } finally {
            setLoading(false);
        }
    }, [name, description, workingDirectory]);

    return (
        <Modal transparent animationType="fade" onRequestClose={onClose}>
            <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onClose}>
                <View style={styles.modal} onStartShouldSetResponder={() => true}>
                    <Text style={styles.modalTitle}>{project ? 'Edit Project' : 'New Project'}</Text>

                    <Text style={styles.label}>Name *</Text>
                    <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="e.g. my-app" autoFocus />

                    <Text style={styles.label}>Description</Text>
                    <TextInput style={styles.input} value={description} onChangeText={setDescription} placeholder="What is this project?" />

                    <Text style={styles.label}>Working Directory</Text>
                    <TextInput style={styles.input} value={workingDirectory} onChangeText={setWorkingDirectory} placeholder="/home/user/my-app" />

                    <View style={styles.formActions}>
                        <TouchableOpacity style={styles.cancelButton} onPress={onClose}>
                            <Text style={styles.cancelText}>Cancel</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={[styles.saveButton, (!name.trim() || loading) && styles.buttonDisabled]}
                            onPress={handleSave}
                            disabled={!name.trim() || loading}
                        >
                            <Text style={styles.saveText}>{loading ? 'Saving...' : 'Save'}</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </TouchableOpacity>
        </Modal>
    );
});

// ============ Styles ============

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#f5f5f5',
    },
    tabs: {
        flexDirection: 'row',
        backgroundColor: '#fff',
        borderBottomWidth: 1,
        borderBottomColor: '#e0e0e0',
    },
    tab: {
        paddingHorizontal: 24,
        paddingVertical: 14,
        borderBottomWidth: 2,
        borderBottomColor: 'transparent',
    },
    tabActive: {
        borderBottomColor: '#1a73e8',
    },
    tabText: {
        fontSize: 14,
        fontWeight: '500',
        color: '#666',
    },
    tabTextActive: {
        color: '#1a73e8',
    },
    content: {
        flex: 1,
        padding: 20,
        maxWidth: 800,
    },
    sectionHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 16,
    },
    sectionTitle: {
        fontSize: 18,
        fontWeight: '700',
        color: '#333',
    },
    addButton: {
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: '#1a73e8',
    },
    addButtonText: {
        color: '#fff',
        fontSize: 13,
        fontWeight: '600',
    },
    card: {
        backgroundColor: '#fff',
        borderRadius: 10,
        padding: 16,
        marginBottom: 12,
        borderWidth: 1,
        borderColor: '#e8e8e8',
    },
    cardHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginBottom: 8,
    },
    cardTitle: {
        fontSize: 16,
        fontWeight: '600',
        color: '#333',
    },
    cardBadge: {
        fontSize: 11,
        color: '#1a73e8',
        backgroundColor: '#e8f0fe',
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 8,
        fontWeight: '500',
    },
    cardDetail: {
        fontSize: 13,
        color: '#666',
        marginBottom: 2,
    },
    cardActions: {
        flexDirection: 'row',
        gap: 16,
        marginTop: 12,
        paddingTop: 12,
        borderTopWidth: 1,
        borderTopColor: '#f0f0f0',
    },
    linkText: {
        fontSize: 13,
        color: '#1a73e8',
        fontWeight: '500',
    },
    dangerLink: {
        fontSize: 13,
        color: '#d93025',
        fontWeight: '500',
    },
    agentChips: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
        marginTop: 4,
    },
    linkedAgent: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#e8f0fe',
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 12,
        gap: 4,
    },
    linkedAgentText: {
        fontSize: 12,
        color: '#1a73e8',
        fontWeight: '500',
    },
    removeAgentText: {
        fontSize: 16,
        color: '#1a73e8',
        fontWeight: '700',
        marginLeft: 2,
    },
    addAgentChip: {
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: '#ddd',
        borderStyle: 'dashed',
    },
    addAgentText: {
        fontSize: 12,
        color: '#999',
    },
    emptyText: {
        fontSize: 14,
        color: '#999',
        textAlign: 'center',
        padding: 40,
    },
    // Modal styles
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
    },
    modalTitle: {
        fontSize: 20,
        fontWeight: '700',
        color: '#333',
        marginBottom: 16,
    },
    label: {
        fontSize: 13,
        fontWeight: '600',
        color: '#555',
        marginBottom: 6,
        marginTop: 12,
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
    typeRow: {
        flexDirection: 'row',
        gap: 8,
        flexWrap: 'wrap',
    },
    typeChip: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 16,
        backgroundColor: '#f0f0f0',
    },
    typeChipActive: {
        backgroundColor: '#1a73e8',
    },
    typeChipText: {
        fontSize: 13,
        color: '#333',
    },
    typeChipTextActive: {
        color: '#fff',
    },
    formActions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        marginTop: 24,
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
    saveButton: {
        paddingHorizontal: 20,
        paddingVertical: 10,
        borderRadius: 8,
        backgroundColor: '#1a73e8',
    },
    buttonDisabled: {
        opacity: 0.5,
    },
    saveText: {
        fontSize: 14,
        color: '#fff',
        fontWeight: '600',
    },
});
