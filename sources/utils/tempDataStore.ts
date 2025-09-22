import { randomUUID } from 'expo-crypto';

export interface TempDataEntry {
    data: any;
    timestamp: number;
}

export interface NewSessionData {
    prompt?: string;
    machineId?: string;
    path?: string;
    agentType?: 'claude' | 'codex';
    sessionType?: 'simple' | 'worktree';
    taskId?: string;
    taskTitle?: string;
}

// In-memory store for temporary data
const tempDataMap = new Map<string, TempDataEntry>();

// Cleanup entries older than 5 minutes
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
const MAX_AGE = 10 * 60 * 1000; // 10 minutes

// Auto-cleanup old entries
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of tempDataMap.entries()) {
        if (now - entry.timestamp > MAX_AGE) {
            tempDataMap.delete(key);
        }
    }
}, CLEANUP_INTERVAL);

/**
 * Store temporary data and return a UUID key
 */
export function storeTempData(data: any): string {
    const key = randomUUID();
    tempDataMap.set(key, {
        data,
        timestamp: Date.now()
    });
    return key;
}

/**
 * Retrieve and remove temporary data by key
 * Data is removed after retrieval to prevent reuse
 */
export function getTempData<T = any>(key: string): T | null {
    const entry = tempDataMap.get(key);
    if (entry) {
        tempDataMap.delete(key); // Remove after retrieval
        return entry.data as T;
    }
    return null;
}

/**
 * Peek at temporary data without removing it
 */
export function peekTempData<T = any>(key: string): T | null {
    const entry = tempDataMap.get(key);
    return entry ? entry.data as T : null;
}

/**
 * Clear all temporary data (useful for testing)
 */
export function clearTempData(): void {
    tempDataMap.clear();
}