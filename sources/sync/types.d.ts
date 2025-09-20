/**
 * Type declarations for optional Expo modules and related functionality
 */

declare module "expo-task-manager" {
	export interface TaskOptions {
		[key: string]: any;
	}

	export interface TaskManagerTask {
		data?: any;
		error?: Error;
	}

	export type TaskManagerTaskExecutor = (
		task: TaskManagerTask,
	) => Promise<void> | void;

	export function defineTask(
		taskName: string,
		task: TaskManagerTaskExecutor,
	): void;
	export function unregisterTaskAsync(taskName: string): Promise<void>;
	export function unregisterAllTasksAsync(): Promise<void>;
	export function getRegisteredTasksAsync(): Promise<string[]>;
	export function isTaskRegisteredAsync(taskName: string): Promise<boolean>;
}

declare module "expo-background-fetch" {
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

	export function registerTaskAsync(
		taskName: string,
		options?: BackgroundFetchOptions,
	): Promise<void>;
	export function unregisterTaskAsync(taskName: string): Promise<void>;
	export function getStatusAsync(): Promise<BackgroundFetchStatus>;
	export function setMinimumIntervalAsync(
		minimumInterval: number,
	): Promise<void>;

	export const Result: typeof BackgroundFetchResult;
	export const Status: typeof BackgroundFetchStatus;
}

declare module "expo-battery" {
	export function getBatteryLevelAsync(): Promise<number>;
	export function getBatteryStateAsync(): Promise<number>;
	export function isLowPowerModeEnabledAsync(): Promise<boolean>;
}
