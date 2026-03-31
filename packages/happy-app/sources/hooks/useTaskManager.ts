/**
 * Hook for managing projects, agents, tasks, and machines in task manager.
 * Uses a Zustand store for state and provides actions that automatically
 * use the current auth credentials from AuthContext.
 */
import * as React from 'react';
import { create } from 'zustand';
import { useAuth } from '@/auth/AuthContext';
import { AuthCredentials } from '@/auth/tokenStorage';
import { ProjectConfig, fetchProjects, createProjectApi, updateProjectApi, deleteProjectApi, addAgentToProjectApi, removeAgentFromProjectApi } from '@/sync/apiProjects';
import { AgentConfig, fetchAgents, createAgentApi, deleteAgentApi } from '@/sync/apiAgents';
import { TaskConfig, TaskStatus, fetchTasks, createTaskApi, runTaskApi, updateTaskStatusApi, deleteTaskApi, sendChatApi } from '@/sync/apiTasks';
import { MachineInfo, fetchMachinesRest, updateMachineApi } from '@/sync/apiMachinesRest';

interface TaskManagerState {
    machines: MachineInfo[];
    machinesLoading: boolean;
    agents: AgentConfig[];
    agentsLoading: boolean;
    projects: ProjectConfig[];
    projectsLoading: boolean;
    selectedProjectId: string | null;
    tasks: TaskConfig[];
    tasksLoading: boolean;
    selectedTaskId: string | null;

    setMachines: (machines: MachineInfo[]) => void;
    setMachinesLoading: (loading: boolean) => void;
    setAgents: (agents: AgentConfig[]) => void;
    setAgentsLoading: (loading: boolean) => void;
    setProjects: (projects: ProjectConfig[]) => void;
    setProjectsLoading: (loading: boolean) => void;
    selectProject: (id: string | null) => void;
    setTasks: (tasks: TaskConfig[]) => void;
    setTasksLoading: (loading: boolean) => void;
    selectTask: (id: string | null) => void;
    updateTask: (id: string, updates: Partial<TaskConfig>) => void;
    addTaskToList: (task: TaskConfig) => void;
    removeTaskFromList: (id: string) => void;
    addProjectToList: (project: ProjectConfig) => void;
    updateProjectInList: (id: string, project: ProjectConfig) => void;
    removeProjectFromList: (id: string) => void;
    addAgentToList: (agent: AgentConfig) => void;
    removeAgentFromList: (id: string) => void;
}

export const useTaskManagerStore = create<TaskManagerState>((set) => ({
    machines: [],
    machinesLoading: false,
    agents: [],
    agentsLoading: false,
    projects: [],
    projectsLoading: false,
    selectedProjectId: null,
    tasks: [],
    tasksLoading: false,
    selectedTaskId: null,

    setMachines: (machines) => set({ machines }),
    setMachinesLoading: (loading) => set({ machinesLoading: loading }),
    setAgents: (agents) => set({ agents }),
    setAgentsLoading: (loading) => set({ agentsLoading: loading }),
    setProjects: (projects) => set({ projects }),
    setProjectsLoading: (loading) => set({ projectsLoading: loading }),
    selectProject: (id) => set({ selectedProjectId: id, selectedTaskId: null, tasks: [] }),
    setTasks: (tasks) => set({ tasks }),
    setTasksLoading: (loading) => set({ tasksLoading: loading }),
    selectTask: (id) => set({ selectedTaskId: id }),
    updateTask: (id, updates) => set((s) => ({
        tasks: s.tasks.map(t => t.id === id ? { ...t, ...updates } : t)
    })),
    addTaskToList: (task) => set((s) => ({ tasks: [task, ...s.tasks] })),
    removeTaskFromList: (id) => set((s) => ({
        tasks: s.tasks.filter(t => t.id !== id),
        ...(s.selectedTaskId === id ? { selectedTaskId: null } : {})
    })),
    addProjectToList: (project) => set((s) => ({ projects: [project, ...s.projects] })),
    updateProjectInList: (id, project) => set((s) => ({
        projects: s.projects.map(p => p.id === id ? project : p)
    })),
    removeProjectFromList: (id) => set((s) => ({
        projects: s.projects.filter(p => p.id !== id),
        ...(s.selectedProjectId === id ? { selectedProjectId: null, tasks: [], selectedTaskId: null } : {})
    })),
    addAgentToList: (agent) => set((s) => ({ agents: [agent, ...s.agents] })),
    removeAgentFromList: (id) => set((s) => ({ agents: s.agents.filter(a => a.id !== id) })),
}));

/**
 * Provides task manager actions bound to the current auth credentials.
 * Returns loading/refresh functions for use in components.
 */
export function useTaskManagerActions() {
    const { credentials } = useAuth();

    const loadProjects = React.useCallback(async () => {
        if (!credentials) return;
        useTaskManagerStore.getState().setProjectsLoading(true);
        try {
            const projects = await fetchProjects(credentials);
            useTaskManagerStore.getState().setProjects(projects);
            const state = useTaskManagerStore.getState();
            if (!state.selectedProjectId && projects.length > 0) {
                useTaskManagerStore.getState().selectProject(projects[0].id);
            }
        } finally {
            useTaskManagerStore.getState().setProjectsLoading(false);
        }
    }, [credentials]);

    const loadAgents = React.useCallback(async () => {
        if (!credentials) return;
        useTaskManagerStore.getState().setAgentsLoading(true);
        try {
            const agents = await fetchAgents(credentials);
            useTaskManagerStore.getState().setAgents(agents);
        } finally {
            useTaskManagerStore.getState().setAgentsLoading(false);
        }
    }, [credentials]);

    const loadMachines = React.useCallback(async () => {
        if (!credentials) return;
        useTaskManagerStore.getState().setMachinesLoading(true);
        try {
            const machines = await fetchMachinesRest(credentials);
            useTaskManagerStore.getState().setMachines(machines);
        } finally {
            useTaskManagerStore.getState().setMachinesLoading(false);
        }
    }, [credentials]);

    const loadTasks = React.useCallback(async (projectId: string) => {
        if (!credentials) return;
        useTaskManagerStore.getState().setTasksLoading(true);
        try {
            const tasks = await fetchTasks(credentials, projectId);
            useTaskManagerStore.getState().setTasks(tasks);
        } finally {
            useTaskManagerStore.getState().setTasksLoading(false);
        }
    }, [credentials]);

    const addProject = React.useCallback(async (data: { name: string; description?: string | null; githubUrl?: string | null }) => {
        if (!credentials) return null;
        const project = await createProjectApi(credentials, data);
        useTaskManagerStore.getState().addProjectToList(project);
        return project;
    }, [credentials]);

    const editProject = React.useCallback(async (id: string, data: { name?: string; description?: string | null; githubUrl?: string | null }) => {
        if (!credentials) return;
        const project = await updateProjectApi(credentials, id, data);
        useTaskManagerStore.getState().updateProjectInList(id, project);
    }, [credentials]);

    const removeProject = React.useCallback(async (id: string) => {
        if (!credentials) return;
        await deleteProjectApi(credentials, id);
        useTaskManagerStore.getState().removeProjectFromList(id);
    }, [credentials]);

    const addAgent = React.useCallback(async (data: { name: string; agentType: string; model?: string }) => {
        if (!credentials) return null;
        const agent = await createAgentApi(credentials, data);
        useTaskManagerStore.getState().addAgentToList(agent);
        return agent;
    }, [credentials]);

    const removeAgent = React.useCallback(async (id: string) => {
        if (!credentials) return;
        await deleteAgentApi(credentials, id);
        useTaskManagerStore.getState().removeAgentFromList(id);
    }, [credentials]);

    const addTask = React.useCallback(async (projectId: string, data: { agentId: string; title: string; description?: string | null }, options?: { yolo?: boolean }) => {
        if (!credentials) return null;
        const task = await createTaskApi(credentials, projectId, data);
        useTaskManagerStore.getState().addTaskToList(task);
        // Run the task immediately after creation
        executeTask(credentials, task.id, task, options);
        return task;
    }, [credentials]);

    const setTaskStatus = React.useCallback(async (id: string, status: TaskStatus) => {
        if (!credentials) return;
        await updateTaskStatusApi(credentials, id, status);
        useTaskManagerStore.getState().updateTask(id, { status });
    }, [credentials]);

    const removeTask = React.useCallback(async (id: string) => {
        if (!credentials) return;
        await deleteTaskApi(credentials, id);
        useTaskManagerStore.getState().removeTaskFromList(id);
    }, [credentials]);

    const renameMachine = React.useCallback(async (id: string, name: string) => {
        if (!credentials) return;
        await updateMachineApi(credentials, id, { displayName: name });
        const machines = useTaskManagerStore.getState().machines;
        useTaskManagerStore.getState().setMachines(
            machines.map(m => m.id === id ? { ...m, displayName: name } : m)
        );
    }, [credentials]);

    return {
        loadProjects,
        loadAgents,
        loadMachines,
        loadTasks,
        addProject,
        editProject,
        removeProject,
        addAgent,
        removeAgent,
        addTask,
        setTaskStatus,
        removeTask,
        renameMachine,
    };
}

/**
 * Fire-and-forget task execution after creation.
 * Runs the task on the server and sends the initial chat message.
 */
async function executeTask(credentials: AuthCredentials, taskId: string, task: TaskConfig, options?: { yolo?: boolean }) {
    try {
        const result = await runTaskApi(credentials, taskId, options?.yolo ? { dangerouslySkipPermissions: true } : undefined);
        if (result.happySessionId) {
            useTaskManagerStore.getState().updateTask(taskId, { happySessionId: result.happySessionId });
            if (task.description) {
                // Wait for agent's socket to connect before sending the first message
                await new Promise(r => setTimeout(r, 3000));
                await sendChatApi(credentials, taskId, task.description).catch(() => {});
            }
        }
    } catch (e: any) {
        const msg = e.message || 'Unknown error';
        console.warn(`Failed to run task: ${msg}`);
        useTaskManagerStore.getState().updateTask(taskId, { status: 'failed', error: msg });
    }
}
