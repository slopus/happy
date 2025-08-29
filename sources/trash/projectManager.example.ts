/**
 * Example usage of the Project Manager system
 * This shows how to use the project management functionality
 */

import { useProjects, useProjectForSession, useProjectSessions } from './storage';
import { getProjectDisplayName, getProjectFullPath } from './projectManager';

// Example React component showing how to use projects
export function ProjectsListExample() {
    // Get all projects
    const projects = useProjects();

    return (
        <div>
            <h2>Projects ({projects.length})</h2>
            {projects.map(project => (
                <div key={project.id}>
                    <h3>{getProjectDisplayName(project)}</h3>
                    <p>{getProjectFullPath(project)}</p>
                    <p>Sessions: {project.sessionIds.length}</p>
                    <p>Last updated: {new Date(project.updatedAt).toLocaleString()}</p>
                </div>
            ))}
        </div>
    );
}

// Example component showing project info for a specific session
export function SessionProjectInfoExample({ sessionId }: { sessionId: string }) {
    const project = useProjectForSession(sessionId);
    const projectSessions = useProjectSessions(project?.id || null);

    if (!project) {
        return <p>Session not in any project</p>;
    }

    return (
        <div>
            <h3>Project: {getProjectDisplayName(project)}</h3>
            <p>Path: {project.key.path}</p>
            <p>Machine: {project.key.machineId}</p>
            <p>Other sessions in this project: {projectSessions.filter(id => id !== sessionId).length}</p>
        </div>
    );
}

// Example of direct project manager usage (non-React)
export function getProjectStats() {
    const { projectManager } = require('./projectManager');
    return projectManager.getStats();
}

export function findProjectsForMachine(machineId: string) {
    const { projectManager } = require('./projectManager');
    return projectManager.getProjects().filter(p => p.key.machineId === machineId);
}