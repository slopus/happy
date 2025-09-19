/**
 * Mock implementations and type definitions for optional Expo modules
 * Provides graceful degradation when expo-task-manager and expo-background-fetch are not available
 */

// Type definitions for expo-task-manager
export interface TaskOptions {
  [key: string]: any;
}

export interface TaskManagerTask {
  data?: any;
  error?: Error;
}

export interface TaskManagerTaskBody {
  (): Promise<void> | void;
}

export interface TaskManagerTaskExecutor {
  (task: TaskManagerTask): Promise<void> | void;
}

// Type definitions for expo-background-fetch
export interface BackgroundFetchOptions {
  minimumInterval?: number;
  stopOnTerminate?: boolean;
  startOnBoot?: boolean;
}

export enum BackgroundFetchResult {
  NoData = 1,
  NewData = 2,
  Failed = 3,
}

export enum BackgroundFetchStatus {
  Denied = 1,
  Restricted = 2,
  Available = 3,
}

// Mock TaskManager implementation
export const TaskManagerMock = {
  defineTask: (taskName: string) => {
    console.warn(`[TaskManager Mock] defineTask called for: ${taskName}. Task registered but will not execute.`);
  },

  unregisterTaskAsync: async (taskName: string) => {
    console.warn(`[TaskManager Mock] unregisterTaskAsync called for: ${taskName}`);
  },

  unregisterAllTasksAsync: async () => {
    console.warn(`[TaskManager Mock] unregisterAllTasksAsync called`);
  },

  getRegisteredTasksAsync: async () => {
    console.warn(`[TaskManager Mock] getRegisteredTasksAsync called`);
    return [];
  },

  isTaskRegisteredAsync: async (taskName: string) => {
    console.warn(`[TaskManager Mock] isTaskRegisteredAsync called for: ${taskName}`);
    return false;
  },
};

// Mock BackgroundFetch implementation
export const BackgroundFetchMock = {
  registerTaskAsync: async (taskName: string) => {
    console.warn(`[BackgroundFetch Mock] registerTaskAsync called for: ${taskName}. Background fetch not available.`);
  },

  unregisterTaskAsync: async (taskName: string) => {
    console.warn(`[BackgroundFetch Mock] unregisterTaskAsync called for: ${taskName}`);
  },

  getStatusAsync: async () => {
    console.warn(`[BackgroundFetch Mock] getStatusAsync called`);
    return BackgroundFetchStatus.Denied;
  },

  setMinimumIntervalAsync: async (minimumInterval: number) => {
    console.warn(`[BackgroundFetch Mock] setMinimumIntervalAsync called with: ${minimumInterval}`);
  },

  Result: BackgroundFetchResult,
  Status: BackgroundFetchStatus,
};

// Conditional import helpers
export function getTaskManager() {
  try {
    // Try to import the actual expo-task-manager
    const TaskManager = require('expo-task-manager');
    return TaskManager;
  } catch {
    console.warn('expo-task-manager not available, using mock implementation');
    return TaskManagerMock;
  }
}

export function getBackgroundFetch() {
  try {
    // Try to import the actual expo-background-fetch
    const BackgroundFetch = require('expo-background-fetch');
    return BackgroundFetch;
  } catch {
    console.warn('expo-background-fetch not available, using mock implementation');
    return BackgroundFetchMock;
  }
}

// Check if actual Expo modules are available
export function isTaskManagerAvailable(): boolean {
  try {
    require('expo-task-manager');
    return true;
  } catch {
    return false;
  }
}

export function isBackgroundFetchAvailable(): boolean {
  try {
    require('expo-background-fetch');
    return true;
  } catch {
    return false;
  }
}

// Export availability info
export const EXPO_MODULES_AVAILABILITY = {
  taskManager: isTaskManagerAvailable(),
  backgroundFetch: isBackgroundFetchAvailable(),
};