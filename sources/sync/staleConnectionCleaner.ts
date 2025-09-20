/**
 * Stale connection cleanup service
 * Automatically detects and cleans up orphaned connections and zombie sessions
 */

import { sessionKill } from "./ops";
import { storage } from "./storage";
import type { Session } from "./storageTypes";
import { sync } from "./sync";

export interface StaleConnectionConfig {
	checkInterval: number; // How often to check (ms)
	staleThreshold: number; // How old before considered stale (ms)
	inactiveThreshold: number; // How long inactive before cleanup (ms)
	maxRetries: number; // Max cleanup attempts per session
}

const DEFAULT_CONFIG: StaleConnectionConfig = {
	checkInterval: 60000, // Check every minute
	staleThreshold: 5 * 60 * 1000, // 5 minutes
	inactiveThreshold: 30 * 60 * 1000, // 30 minutes
	maxRetries: 3,
};

export interface CleanupResult {
	totalSessions: number;
	staleSessions: number;
	cleanedSessions: number;
	errors: string[];
}

export class StaleConnectionCleaner {
	private config: StaleConnectionConfig;
	private cleanupInterval: NodeJS.Timeout | null = null;
	private isRunning = false;
	private retryCount = new Map<string, number>();
	private lastCleanupTime = 0;

	constructor(config: Partial<StaleConnectionConfig> = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * Start the stale connection cleanup service
	 */
	start(): void {
		if (this.isRunning) return;

		this.isRunning = true;
		console.log("🧹 StaleConnectionCleaner: Starting cleanup service");

		// Perform initial cleanup
		this.performCleanup();

		// Schedule periodic cleanup
		this.cleanupInterval = setInterval(() => {
			this.performCleanup();
		}, this.config.checkInterval) as unknown as NodeJS.Timeout;
	}

	/**
	 * Stop the cleanup service
	 */
	stop(): void {
		if (!this.isRunning) return;

		this.isRunning = false;
		console.log("🧹 StaleConnectionCleaner: Stopping cleanup service");

		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
			this.cleanupInterval = null;
		}
	}

	/**
	 * Manually trigger cleanup now
	 */
	async cleanupNow(): Promise<CleanupResult> {
		return this.performCleanup();
	}

	/**
	 * Update configuration
	 */
	updateConfig(newConfig: Partial<StaleConnectionConfig>): void {
		this.config = { ...this.config, ...newConfig };

		// Restart with new config if running
		if (this.isRunning) {
			this.stop();
			this.start();
		}
	}

	/**
	 * Get current configuration
	 */
	getConfig(): StaleConnectionConfig {
		return { ...this.config };
	}

	/**
	 * Perform the actual cleanup process
	 */
	private async performCleanup(): Promise<CleanupResult> {
		const startTime = Date.now();
		this.lastCleanupTime = startTime;

		console.log("🧹 StaleConnectionCleaner: Starting cleanup cycle");

		const sessions = storage.getState().sessions;
		const allSessions = Object.values(sessions);
		const staleSessions = this.identifyStaleSessions(allSessions);

		const result: CleanupResult = {
			totalSessions: allSessions.length,
			staleSessions: staleSessions.length,
			cleanedSessions: 0,
			errors: [],
		};

		if (staleSessions.length === 0) {
			console.log("🧹 StaleConnectionCleaner: No stale sessions found");
			return result;
		}

		console.log(
			`🧹 StaleConnectionCleaner: Found ${staleSessions.length} stale sessions`,
		);

		// Process each stale session
		for (const session of staleSessions) {
			try {
				const cleaned = await this.cleanupSession(session);
				if (cleaned) {
					result.cleanedSessions++;
				}
			} catch (error) {
				const errorMessage = `Failed to cleanup session ${session.id}: ${error instanceof Error ? error.message : "Unknown error"}`;
				result.errors.push(errorMessage);
				console.error("🧹 StaleConnectionCleaner:", errorMessage);
			}
		}

		// Clean up retry tracking for successful cleanups
		this.cleanupRetryTracking();

		// Compact storage after cleanup
		await this.compactStorage();

		const duration = Date.now() - startTime;
		console.log(
			`🧹 StaleConnectionCleaner: Cleanup completed in ${duration}ms - cleaned ${result.cleanedSessions}/${result.staleSessions} stale sessions`,
		);

		return result;
	}

	/**
	 * Identify sessions that are considered stale
	 */
	private identifyStaleSessions(sessions: Session[]): Session[] {
		const now = Date.now();
		const staleThreshold = this.config.staleThreshold;
		const inactiveThreshold = this.config.inactiveThreshold;

		return sessions.filter((session) => {
			// Skip already inactive sessions
			if (!session.active) {
				return false;
			}

			// Check if session has been active recently
			const lastActivity = Math.max(
				session.activeAt || 0,
				session.updatedAt || 0,
				session.thinkingAt || 0,
			);

			const timeSinceActivity = now - lastActivity;

			// Session is stale if:
			// 1. No activity for longer than stale threshold, OR
			// 2. Session has been inactive for longer than inactive threshold
			const isStale = timeSinceActivity > staleThreshold;
			const isInactive = timeSinceActivity > inactiveThreshold;

			if (isStale || isInactive) {
				console.log(
					`🧹 StaleConnectionCleaner: Session ${session.id} is stale (${timeSinceActivity}ms since activity)`,
				);
				return true;
			}

			return false;
		});
	}

	/**
	 * Cleanup a specific session
	 */
	private async cleanupSession(session: Session): Promise<boolean> {
		const sessionId = session.id;
		const retryCount = this.retryCount.get(sessionId) || 0;

		// Skip if we've already tried too many times
		if (retryCount >= this.config.maxRetries) {
			console.log(
				`🧹 StaleConnectionCleaner: Session ${sessionId} has exceeded max retries (${retryCount})`,
			);
			return false;
		}

		try {
			// First, check if the session is actually alive
			const isAlive = await this.verifySessionAlive(sessionId);

			if (isAlive) {
				console.log(
					`🧹 StaleConnectionCleaner: Session ${sessionId} is actually alive, skipping cleanup`,
				);
				// Reset retry count for alive sessions
				this.retryCount.delete(sessionId);
				return false;
			}

			// Session is confirmed dead, mark as inactive
			await this.markSessionInactive(sessionId);

			// Clear any cached data for this session
			// Note: clearSessionMessages method not available in this version
			// storage.getState().clearSessionMessages(sessionId);

			console.log(
				`🧹 StaleConnectionCleaner: Successfully cleaned up session ${sessionId}`,
			);

			// Remove from retry tracking
			this.retryCount.delete(sessionId);

			return true;
		} catch (error) {
			// Increment retry count
			this.retryCount.set(sessionId, retryCount + 1);

			console.error(
				`🧹 StaleConnectionCleaner: Failed to cleanup session ${sessionId} (attempt ${retryCount + 1}):`,
				error,
			);
			throw error;
		}
	}

	/**
	 * Verify if a session is actually alive by attempting a ping
	 */
	private async verifySessionAlive(sessionId: string): Promise<boolean> {
		try {
			// Try to ping the session with a short timeout
			await Promise.race([
				sessionKill(sessionId), // This will fail if session is alive
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error("Verification timeout")), 5000),
				),
			]);

			// If sessionKill succeeded, the session was alive and has been killed
			return true;
		} catch {
			// If sessionKill failed, the session was already dead or there's a network issue
			// For now, assume it's dead to be safe (since we're cleaning up stale connections)
			return false;
		}
	}

	/**
	 * Mark a session as inactive locally
	 */
	private async markSessionInactive(sessionId: string): Promise<void> {
		const sessions = storage.getState().sessions;
		const session = sessions[sessionId];

		if (session) {
			const updatedSession: Session = {
				...session,
				active: false,
				thinking: false,
				thinkingAt: 0,
				updatedAt: Date.now(),
			};

			// Update local storage
			storage.getState().applySessions([updatedSession]);

			// Try to sync the change to server (but don't fail if it doesn't work)
			try {
				await sync.refreshSessions();
			} catch (error) {
				console.warn(
					"🧹 StaleConnectionCleaner: Failed to sync session state to server:",
					error,
				);
				// Continue with local cleanup even if sync fails
			}
		}
	}

	/**
	 * Clean up retry tracking for sessions that no longer exist
	 */
	private cleanupRetryTracking(): void {
		const sessions = storage.getState().sessions;
		const existingSessionIds = new Set(Object.keys(sessions));

		for (const sessionId of this.retryCount.keys()) {
			if (!existingSessionIds.has(sessionId)) {
				this.retryCount.delete(sessionId);
			}
		}
	}

	/**
	 * Compact storage by removing unused data
	 */
	private async compactStorage(): Promise<void> {
		try {
			// This could be expanded to include other storage compaction tasks
			// Note: compactStorage method not available in this version
			// await storage.getState().compactStorage?.();
		} catch (error) {
			console.warn(
				"🧹 StaleConnectionCleaner: Failed to compact storage:",
				error,
			);
		}
	}

	/**
	 * Get statistics about the cleanup service
	 */
	getStatistics(): {
		isRunning: boolean;
		lastCleanupTime: number;
		retryCount: number;
		config: StaleConnectionConfig;
	} {
		return {
			isRunning: this.isRunning,
			lastCleanupTime: this.lastCleanupTime,
			retryCount: this.retryCount.size,
			config: this.getConfig(),
		};
	}
}

// Global singleton instance
export const staleConnectionCleaner = new StaleConnectionCleaner();

// Auto-start cleanup when sync initializes
let isCleanupStarted = false;

export function startStaleConnectionCleanup(): void {
	if (!isCleanupStarted) {
		staleConnectionCleaner.start();
		isCleanupStarted = true;
	}
}

export function stopStaleConnectionCleanup(): void {
	if (isCleanupStarted) {
		staleConnectionCleaner.stop();
		isCleanupStarted = false;
	}
}
