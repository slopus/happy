/**
 * Task-Session Linking
 * Manages the relationship between tasks and their clarification sessions
 */

export interface TaskSessionLink {
    sessionId: string;
    taskId: string;
    taskTitle: string;
    promptDisplayTitle: string;
    createdAt: number;
}

// In-memory storage for task-session relationships
// Map from taskId to session links
const taskSessionMap = new Map<string, TaskSessionLink[]>();

// Map from sessionId to task link
const sessionTaskMap = new Map<string, TaskSessionLink>();

/**
 * Link a task to a session
 */
export function linkTaskToSession(
    taskId: string,
    sessionId: string,
    taskTitle: string,
    promptDisplayTitle: string
): void {
    const link: TaskSessionLink = {
        sessionId,
        taskId,
        taskTitle,
        promptDisplayTitle,
        createdAt: Date.now()
    };

    // Add to task -> sessions map
    const existingLinks = taskSessionMap.get(taskId) || [];
    existingLinks.push(link);
    taskSessionMap.set(taskId, existingLinks);

    // Add to session -> task map
    sessionTaskMap.set(sessionId, link);
}

/**
 * Get all sessions linked to a task
 */
export function getSessionsForTask(taskId: string): TaskSessionLink[] {
    return taskSessionMap.get(taskId) || [];
}

/**
 * Get the task linked to a session
 */
export function getTaskForSession(sessionId: string): TaskSessionLink | null {
    return sessionTaskMap.get(sessionId) || null;
}

/**
 * Remove a session link (when session is deleted)
 */
export function removeSessionLink(sessionId: string): void {
    const link = sessionTaskMap.get(sessionId);
    if (link) {
        // Remove from session map
        sessionTaskMap.delete(sessionId);

        // Remove from task map
        const taskLinks = taskSessionMap.get(link.taskId);
        if (taskLinks) {
            const filtered = taskLinks.filter(l => l.sessionId !== sessionId);
            if (filtered.length > 0) {
                taskSessionMap.set(link.taskId, filtered);
            } else {
                taskSessionMap.delete(link.taskId);
            }
        }
    }
}

/**
 * Remove all links for a task (when task is deleted)
 */
export function removeTaskLinks(taskId: string): void {
    const links = taskSessionMap.get(taskId);
    if (links) {
        // Remove all session links
        links.forEach(link => {
            sessionTaskMap.delete(link.sessionId);
        });
        // Remove task entry
        taskSessionMap.delete(taskId);
    }
}

/**
 * Get all task-session links (for debugging)
 */
export function getAllTaskSessionLinks(): {
    taskMap: Map<string, TaskSessionLink[]>;
    sessionMap: Map<string, TaskSessionLink>;
} {
    return {
        taskMap: taskSessionMap,
        sessionMap: sessionTaskMap
    };
}