import { create } from 'zustand';
import { AgentConfig, listAgents, createAgent, updateAgent, deleteAgent } from '@/api/agents';
import { ProjectConfig, listProjects, createProject, updateProject, deleteProject, addAgentToProject, removeAgentFromProject } from '@/api/projects';
import { TaskConfig, listTasks, createTask, updateTaskStatus, deleteTask, TaskStatus } from '@/api/tasks';

interface AppState {
    // Agents
    agents: AgentConfig[];
    agentsLoading: boolean;
    loadAgents: () => Promise<void>;
    addAgent: (data: Parameters<typeof createAgent>[0]) => Promise<AgentConfig>;
    editAgent: (id: string, data: Parameters<typeof updateAgent>[1]) => Promise<void>;
    removeAgent: (id: string) => Promise<void>;

    // Projects
    projects: ProjectConfig[];
    projectsLoading: boolean;
    selectedProjectId: string | null;
    loadProjects: () => Promise<void>;
    selectProject: (id: string | null) => void;
    addProject: (data: Parameters<typeof createProject>[0]) => Promise<ProjectConfig>;
    editProject: (id: string, data: Parameters<typeof updateProject>[1]) => Promise<void>;
    removeProject: (id: string) => Promise<void>;
    linkAgent: (projectId: string, agentId: string) => Promise<void>;
    unlinkAgent: (projectId: string, agentId: string) => Promise<void>;

    // Tasks
    tasks: TaskConfig[];
    tasksLoading: boolean;
    selectedTaskId: string | null;
    loadTasks: (projectId: string) => Promise<void>;
    selectTask: (id: string | null) => void;
    addTask: (projectId: string, data: Parameters<typeof createTask>[1]) => Promise<TaskConfig>;
    setTaskStatus: (id: string, status: TaskStatus) => Promise<void>;
    removeTask: (id: string) => Promise<void>;
}

export const useStore = create<AppState>((set, get) => ({
    // Agents
    agents: [],
    agentsLoading: false,
    loadAgents: async () => {
        set({ agentsLoading: true });
        const agents = await listAgents();
        set({ agents, agentsLoading: false });
    },
    addAgent: async (data) => {
        const agent = await createAgent(data);
        set(s => ({ agents: [agent, ...s.agents] }));
        return agent;
    },
    editAgent: async (id, data) => {
        const agent = await updateAgent(id, data);
        set(s => ({ agents: s.agents.map(a => a.id === id ? agent : a) }));
    },
    removeAgent: async (id) => {
        await deleteAgent(id);
        set(s => ({ agents: s.agents.filter(a => a.id !== id) }));
    },

    // Projects
    projects: [],
    projectsLoading: false,
    selectedProjectId: null,
    loadProjects: async () => {
        set({ projectsLoading: true });
        const projects = await listProjects();
        set({ projects, projectsLoading: false });
    },
    selectProject: (id) => {
        set({ selectedProjectId: id, selectedTaskId: null, tasks: [] });
        if (id) {
            get().loadTasks(id);
        }
    },
    addProject: async (data) => {
        const project = await createProject(data);
        set(s => ({ projects: [project, ...s.projects] }));
        return project;
    },
    editProject: async (id, data) => {
        const project = await updateProject(id, data);
        set(s => ({ projects: s.projects.map(p => p.id === id ? project : p) }));
    },
    removeProject: async (id) => {
        await deleteProject(id);
        set(s => ({
            projects: s.projects.filter(p => p.id !== id),
            ...(s.selectedProjectId === id ? { selectedProjectId: null, tasks: [], selectedTaskId: null } : {})
        }));
    },
    linkAgent: async (projectId, agentId) => {
        await addAgentToProject(projectId, agentId);
        await get().loadProjects();
    },
    unlinkAgent: async (projectId, agentId) => {
        await removeAgentFromProject(projectId, agentId);
        await get().loadProjects();
    },

    // Tasks
    tasks: [],
    tasksLoading: false,
    selectedTaskId: null,
    loadTasks: async (projectId) => {
        set({ tasksLoading: true });
        const tasks = await listTasks(projectId);
        set({ tasks, tasksLoading: false });
    },
    selectTask: (id) => set({ selectedTaskId: id }),
    addTask: async (projectId, data) => {
        const task = await createTask(projectId, data);
        set(s => ({ tasks: [task, ...s.tasks] }));
        return task;
    },
    setTaskStatus: async (id, status) => {
        await updateTaskStatus(id, status);
        set(s => ({
            tasks: s.tasks.map(t => t.id === id ? { ...t, status } : t)
        }));
    },
    removeTask: async (id) => {
        await deleteTask(id);
        set(s => ({
            tasks: s.tasks.filter(t => t.id !== id),
            ...(s.selectedTaskId === id ? { selectedTaskId: null } : {})
        }));
    }
}));
