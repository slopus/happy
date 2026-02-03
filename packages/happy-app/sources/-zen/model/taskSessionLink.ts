/**
 * Task-Session Linking
 * Manages the relationship between tasks and their clarification sessions
 */

import { storage } from '@/sync/storage';
import { updateTodoLinkedSessions } from './ops';

export interface TaskSessionLink {
    sessionId: string;
    title: string;
    linkedAt: number;
}

/**
 * Link a task to a session
 */
export async function linkTaskToSession(
    taskId: string,
    sessionId: string,
    taskTitle: string,
    promptDisplayTitle: string
): Promise<void> {
    const todo = storage.getState().todoState?.todos[taskId];
    if (!todo) {
        console.error(`Todo ${taskId} not found`);
        return;
    }

    // Add session link to todo's linkedSessions map
    const linkedSessions = {
        ...todo.linkedSessions,
        [sessionId]: {
            title: promptDisplayTitle,
            linkedAt: Date.now()
        }
    };

    // Update the todo with the new linked session
    await updateTodoLinkedSessions(taskId, linkedSessions);
}

/**
 * Get all sessions linked to a task
 */
export function getSessionsForTask(taskId: string): TaskSessionLink[] {
    const todo = storage.getState().todoState?.todos[taskId];
    if (!todo?.linkedSessions) return [];

    // Convert map to array and sort by linkedAt (newest first)
    return Object.entries(todo.linkedSessions)
        .map(([sessionId, data]) => ({
            sessionId,
            title: data.title,
            linkedAt: data.linkedAt
        }))
        .sort((a, b) => b.linkedAt - a.linkedAt);
}

/**
 * Get the task linked to a session
 */
export function getTaskForSession(sessionId: string): { taskId: string; title: string; linkedAt: number } | null {
    const todos = storage.getState().todoState?.todos || {};

    for (const [taskId, todo] of Object.entries(todos)) {
        if (todo.linkedSessions?.[sessionId]) {
            return {
                taskId,
                title: todo.linkedSessions[sessionId].title,
                linkedAt: todo.linkedSessions[sessionId].linkedAt
            };
        }
    }

    return null;
}

/**
 * Remove a session link (when session is deleted)
 */
export async function removeSessionLink(sessionId: string): Promise<void> {
    const todos = storage.getState().todoState?.todos || {};

    for (const [taskId, todo] of Object.entries(todos)) {
        if (todo.linkedSessions?.[sessionId]) {
            // Remove the session link from the map
            const { [sessionId]: removed, ...remaining } = todo.linkedSessions;

            // Update the todo with the remaining linked sessions
            await updateTodoLinkedSessions(taskId, remaining);
            break;
        }
    }
}

/**
 * Remove all links for a task (when task is deleted)
 */
export function removeTaskLinks(taskId: string): void {
    // No action needed - links are stored in the task itself
    // When task is deleted, its linkedSessions are deleted with it
}

/**
 * Get all task-session links (for debugging)
 */
export function getAllTaskSessionLinks(): {
    [taskId: string]: TaskSessionLink[];
} {
    const todos = storage.getState().todoState?.todos || {};
    const result: { [taskId: string]: TaskSessionLink[] } = {};

    for (const [taskId, todo] of Object.entries(todos)) {
        if (todo.linkedSessions) {
            result[taskId] = Object.entries(todo.linkedSessions).map(([sessionId, data]) => ({
                sessionId,
                title: data.title,
                linkedAt: data.linkedAt
            }));
        }
    }

    return result;
}