/**
 * Project Management System
 * Groups sessions by machine ID and path to create project entities
 */

import { Session, MachineMetadata, GitStatus } from "./storageTypes";

/**
 * Unique project identifier based on machine ID and path
 */
export interface ProjectKey {
    machineId: string;
    path: string;
}

/**
 * Project entity that groups sessions by location
 */
export interface Project {
    /** Unique internal ID (not stable between app restarts) */
    id: string;
    /** Project identifier */
    key: ProjectKey;
    /** List of active session IDs in this project */
    sessionIds: string[];
    /** Optional machine metadata */
    machineMetadata?: MachineMetadata | null;
    /** Git status for this project (shared across all sessions) */
    gitStatus?: GitStatus | null;
    /** Timestamp when git status was last updated */
    lastGitStatusUpdate?: number;
    /** Project creation timestamp */
    createdAt: number;
    /** Last update timestamp */
    updatedAt: number;
}

/**
 * In-memory project manager
 */
class ProjectManager {
    private projects: Map<string, Project> = new Map();
    private projectKeyToId: Map<string, string> = new Map();
    private sessionToProject: Map<string, string> = new Map();
    private nextProjectId = 1;

    /**
     * Generate a unique key string from machine ID and path
     */
    private getProjectKeyString(key: ProjectKey): string {
        return `${key.machineId}:${key.path}`;
    }

    /**
     * Generate a new unique project ID
     */
    private generateProjectId(): string {
        return `project_${this.nextProjectId++}`;
    }

    /**
     * Get or create a project for the given key
     */
    private getOrCreateProject(key: ProjectKey, machineMetadata?: MachineMetadata | null): Project {
        const keyString = this.getProjectKeyString(key);
        let projectId = this.projectKeyToId.get(keyString);

        if (!projectId) {
            // Create new project
            projectId = this.generateProjectId();
            const now = Date.now();
            
            const project: Project = {
                id: projectId,
                key,
                sessionIds: [],
                machineMetadata,
                createdAt: now,
                updatedAt: now
            };

            this.projects.set(projectId, project);
            this.projectKeyToId.set(keyString, projectId);
            
            return project;
        }

        const project = this.projects.get(projectId)!;
        
        // Update machine metadata if provided and different
        if (machineMetadata && project.machineMetadata !== machineMetadata) {
            project.machineMetadata = machineMetadata;
            project.updatedAt = Date.now();
        }

        return project;
    }

    /**
     * Add or update a session in the project system
     */
    addSession(session: Session, machineMetadata?: MachineMetadata | null): void {
        // Session must have metadata with machineId and path
        if (!session.metadata?.machineId || !session.metadata?.path) {
            return;
        }

        const projectKey: ProjectKey = {
            machineId: session.metadata.machineId,
            path: session.metadata.path
        };

        const project = this.getOrCreateProject(projectKey, machineMetadata);

        // Remove session from previous project if it was in one
        const previousProjectId = this.sessionToProject.get(session.id);
        if (previousProjectId && previousProjectId !== project.id) {
            const previousProject = this.projects.get(previousProjectId);
            if (previousProject) {
                const index = previousProject.sessionIds.indexOf(session.id);
                if (index !== -1) {
                    previousProject.sessionIds.splice(index, 1);
                    previousProject.updatedAt = Date.now();
                    
                    // Remove empty projects
                    if (previousProject.sessionIds.length === 0) {
                        this.removeProject(previousProjectId);
                    }
                }
            }
        }

        // Add session to new project if not already there
        if (!project.sessionIds.includes(session.id)) {
            project.sessionIds.push(session.id);
            project.updatedAt = Date.now();
        }

        this.sessionToProject.set(session.id, project.id);
    }

    /**
     * Remove a session from the project system
     */
    removeSession(sessionId: string): void {
        const projectId = this.sessionToProject.get(sessionId);
        if (!projectId) {
            return;
        }

        const project = this.projects.get(projectId);
        if (!project) {
            this.sessionToProject.delete(sessionId);
            return;
        }

        // Remove session from project
        const index = project.sessionIds.indexOf(sessionId);
        if (index !== -1) {
            project.sessionIds.splice(index, 1);
            project.updatedAt = Date.now();
        }

        this.sessionToProject.delete(sessionId);

        // Remove empty projects
        if (project.sessionIds.length === 0) {
            this.removeProject(projectId);
        }
    }

    /**
     * Remove a project completely
     */
    private removeProject(projectId: string): void {
        const project = this.projects.get(projectId);
        if (!project) {
            return;
        }

        // Clean up all references
        const keyString = this.getProjectKeyString(project.key);
        this.projectKeyToId.delete(keyString);
        this.projects.delete(projectId);

        // Remove session mappings
        for (const sessionId of project.sessionIds) {
            this.sessionToProject.delete(sessionId);
        }
    }

    /**
     * Get all projects
     */
    getProjects(): Project[] {
        return Array.from(this.projects.values())
            .sort((a, b) => b.updatedAt - a.updatedAt); // Most recently updated first
    }

    /**
     * Get project by ID
     */
    getProject(projectId: string): Project | null {
        return this.projects.get(projectId) || null;
    }

    /**
     * Get project for a session
     */
    getProjectForSession(sessionId: string): Project | null {
        const projectId = this.sessionToProject.get(sessionId);
        if (!projectId) {
            return null;
        }
        return this.projects.get(projectId) || null;
    }

    /**
     * Get sessions for a project
     */
    getProjectSessions(projectId: string): string[] {
        const project = this.projects.get(projectId);
        return project ? [...project.sessionIds] : [];
    }

    /**
     * Update multiple sessions at once (for bulk operations)
     */
    updateSessions(sessions: Session[], machineMetadataMap?: Map<string, MachineMetadata>): void {
        // Track which sessions are still active
        const activeSessionIds = new Set(sessions.map(s => s.id));
        
        // Remove sessions that are no longer in the list
        const currentSessionIds = new Set(this.sessionToProject.keys());
        for (const sessionId of currentSessionIds) {
            if (!activeSessionIds.has(sessionId)) {
                this.removeSession(sessionId);
            }
        }

        // Add or update all current sessions
        for (const session of sessions) {
            const machineMetadata = session.metadata?.machineId 
                ? machineMetadataMap?.get(session.metadata.machineId)
                : undefined;
            this.addSession(session, machineMetadata);
        }
    }

    /**
     * Update git status for a project (identified by project key)
     */
    updateProjectGitStatus(projectKey: ProjectKey, gitStatus: GitStatus | null): void {
        const keyString = this.getProjectKeyString(projectKey);
        const projectId = this.projectKeyToId.get(keyString);
        
        if (!projectId) {
            // No project exists for this key, skip update
            return;
        }

        const project = this.projects.get(projectId);
        if (!project) {
            return;
        }

        // Update git status and timestamp
        project.gitStatus = gitStatus;
        project.lastGitStatusUpdate = Date.now();
        project.updatedAt = Date.now();
    }

    /**
     * Update git status for a project (identified by project ID)
     */
    updateProjectGitStatusById(projectId: string, gitStatus: GitStatus | null): void {
        const project = this.projects.get(projectId);
        if (!project) {
            return;
        }

        project.gitStatus = gitStatus;
        project.lastGitStatusUpdate = Date.now();
        project.updatedAt = Date.now();
    }

    /**
     * Get git status for a project
     */
    getProjectGitStatus(projectId: string): GitStatus | null {
        const project = this.projects.get(projectId);
        return project?.gitStatus || null;
    }

    /**
     * Clear git status for a project
     */
    clearProjectGitStatus(projectId: string): void {
        const project = this.projects.get(projectId);
        if (project) {
            project.gitStatus = null;
            project.lastGitStatusUpdate = Date.now();
            project.updatedAt = Date.now();
        }
    }

    /**
     * Get git status for a session via its project
     */
    getSessionProjectGitStatus(sessionId: string): GitStatus | null {
        const project = this.getProjectForSession(sessionId);
        return project?.gitStatus || null;
    }

    /**
     * Update git status for a session's project
     */
    updateSessionProjectGitStatus(sessionId: string, gitStatus: GitStatus | null): void {
        const project = this.getProjectForSession(sessionId);
        if (project) {
            this.updateProjectGitStatusById(project.id, gitStatus);
        }
    }

    /**
     * Clear all projects (useful for testing or resetting state)
     */
    clear(): void {
        this.projects.clear();
        this.projectKeyToId.clear();
        this.sessionToProject.clear();
        this.nextProjectId = 1;
    }

    /**
     * Get statistics about the project system
     */
    getStats(): {
        projectCount: number;
        sessionCount: number;
        avgSessionsPerProject: number;
    } {
        const projectCount = this.projects.size;
        const sessionCount = this.sessionToProject.size;
        const avgSessionsPerProject = projectCount > 0 ? sessionCount / projectCount : 0;

        return {
            projectCount,
            sessionCount,
            avgSessionsPerProject: Math.round(avgSessionsPerProject * 100) / 100
        };
    }
}

// Singleton instance
export const projectManager = new ProjectManager();

/**
 * Helper function to create a project key
 */
export function createProjectKey(machineId: string, path: string): ProjectKey {
    return { machineId, path };
}

/**
 * Helper function to get project display name
 */
export function getProjectDisplayName(project: Project): string {
    // Try to extract folder name from path
    const pathParts = project.key.path.split('/').filter(Boolean);
    const folderName = pathParts[pathParts.length - 1];
    
    if (folderName) {
        return folderName;
    }

    // Fallback to path
    return project.key.path || 'Unknown Project';
}

/**
 * Helper function to get project full path display
 */
export function getProjectFullPath(project: Project): string {
    const machineName = project.machineMetadata?.displayName || project.machineMetadata?.host || project.key.machineId;
    return `${machineName}: ${project.key.path}`;
}