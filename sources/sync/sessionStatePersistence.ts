/**
 * Enhanced session state persistence system
 * Provides continuous backup and recovery of session state during network interruptions
 */

import { storage } from './storage';
import { apiSocket } from './apiSocket';
import type { Session } from './storageTypes';
// Platform-agnostic storage - falls back to localStorage on web
let platformStorage: any;
try {
  // Try React Native platformStorage first
  platformStorage = require('@react-native-async-storage/async-storage').default;
} catch {
  // Fallback to web localStorage with platformStorage-like interface
  platformStorage = {
    async getItem(key: string): Promise<string | null> {
      if (typeof window !== 'undefined' && window.localStorage) {
        return window.localStorage.getItem(key);
      }
      return null;
    },
    async setItem(key: string, value: string): Promise<void> {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(key, value);
      }
    },
    async removeItem(key: string): Promise<void> {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.removeItem(key);
      }
    },
    async getAllKeys(): Promise<string[]> {
      if (typeof window !== 'undefined' && window.localStorage) {
        return Object.keys(window.localStorage);
      }
      return [];
    },
    async multiGet(keys: string[]): Promise<[string, string | null][]> {
      if (typeof window !== 'undefined' && window.localStorage) {
        return keys.map((key: string): [string, string | null] => [key, window.localStorage.getItem(key)]);
      }
      return keys.map((key: string): [string, string | null] => [key, null]);
    },
    async multiSet(keyValuePairs: [string, string][]): Promise<void> {
      if (typeof window !== 'undefined' && window.localStorage) {
        keyValuePairs.forEach(([key, value]) => {
          window.localStorage.setItem(key, value);
        });
      }
    },
    async multiRemove(keys: string[]): Promise<void> {
      if (typeof window !== 'undefined' && window.localStorage) {
        keys.forEach((key: string) => {
          window.localStorage.removeItem(key);
        });
      }
    },
  };
}

export interface SessionStateBackup {
  sessionId: string;
  state: Session;
  timestamp: number;
  version: number;
}

export interface SessionStatePersistenceConfig {
  backupInterval: number;         // How often to backup (ms)
  maxBackups: number;            // Max backups per session
  maxBackupAge: number;          // Max age of backups (ms)
  conflictResolution: 'local' | 'remote' | 'merge'; // How to resolve conflicts
}

const DEFAULT_CONFIG: SessionStatePersistenceConfig = {
  backupInterval: 10000,          // 10 seconds
  maxBackups: 10,
  maxBackupAge: 24 * 60 * 60 * 1000, // 24 hours
  conflictResolution: 'merge',
};

const STORAGE_PREFIX = 'session_backup_';

export class SessionStatePersistence {
  private config: SessionStatePersistenceConfig;
  private backupInterval: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private localStateCache = new Map<string, SessionStateBackup>();
  private lastBackupTime = 0;

  constructor(config: Partial<SessionStatePersistenceConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Listen for connection events to trigger reconciliation
    this.setupConnectionListeners();
  }

  /**
   * Start session state persistence
   */
  start(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    console.log('💾 SessionStatePersistence: Starting persistence service');

    // Load existing backups from storage
    this.loadBackupsFromStorage();

    // Perform initial backup
    this.backupCurrentState();

    // Schedule periodic backups
    this.backupInterval = setInterval(() => {
      this.backupCurrentState();
    }, this.config.backupInterval);
  }

  /**
   * Stop session state persistence
   */
  stop(): void {
    if (!this.isRunning) return;

    this.isRunning = false;
    console.log('💾 SessionStatePersistence: Stopping persistence service');

    if (this.backupInterval) {
      clearInterval(this.backupInterval);
      this.backupInterval = null;
    }

    // Save final state
    this.backupCurrentState();
  }

  /**
   * Manually trigger a backup now
   */
  async backupNow(): Promise<void> {
    await this.backupCurrentState();
  }

  /**
   * Get backup for a specific session
   */
  getBackup(sessionId: string): SessionStateBackup | null {
    return this.localStateCache.get(sessionId) || null;
  }

  /**
   * Get all backups
   */
  getAllBackups(): SessionStateBackup[] {
    return Array.from(this.localStateCache.values());
  }

  /**
   * Clear backups for a specific session
   */
  async clearBackup(sessionId: string): Promise<void> {
    this.localStateCache.delete(sessionId);
    await platformStorage.removeItem(`${STORAGE_PREFIX}${sessionId}`);
  }

  /**
   * Clear all backups
   */
  async clearAllBackups(): Promise<void> {
    const keys = Array.from(this.localStateCache.keys());
    this.localStateCache.clear();

    // Remove from platformStorage
    const storageKeys = keys.map(sessionId => `${STORAGE_PREFIX}${sessionId}`);
    await platformStorage.multiRemove(storageKeys);
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<SessionStatePersistenceConfig>): void {
    this.config = { ...this.config, ...newConfig };

    // Restart with new config if running
    if (this.isRunning) {
      this.stop();
      this.start();
    }
  }

  /**
   * Backup current session state
   */
  private async backupCurrentState(): Promise<void> {
    try {
      const now = Date.now();
      this.lastBackupTime = now;

      const sessions = storage.getState().sessions;
      const backupsToSave: Array<{ key: string; value: string }> = [];

      for (const [sessionId, session] of Object.entries(sessions)) {
        // Only backup active sessions or recently active ones
        const lastActivity = Math.max(
          session.activeAt || 0,
          session.updatedAt || 0,
          session.thinkingAt || 0,
        );

        const timeSinceActivity = now - lastActivity;
        if (timeSinceActivity > this.config.maxBackupAge) {
          continue; // Skip very old sessions
        }

        const backup: SessionStateBackup = {
          sessionId,
          state: { ...session },
          timestamp: now,
          version: session.metadataVersion || 0,
        };

        // Update cache
        this.localStateCache.set(sessionId, backup);

        // Prepare for storage
        backupsToSave.push({
          key: `${STORAGE_PREFIX}${sessionId}`,
          value: JSON.stringify(backup),
        });
      }

      // Save to platformStorage
      if (backupsToSave.length > 0) {
        const keyValuePairs = backupsToSave.map(item => [item.key, item.value] as [string, string]);
        await platformStorage.multiSet(keyValuePairs);
      }

      // Clean up old backups
      await this.cleanupOldBackups();

      console.log(`💾 SessionStatePersistence: Backed up ${backupsToSave.length} sessions`);

    } catch (error) {
      console.error('💾 SessionStatePersistence: Failed to backup state:', error);
    }
  }

  /**
   * Load backups from platformStorage
   */
  private async loadBackupsFromStorage(): Promise<void> {
    try {
      const allKeys = await platformStorage.getAllKeys();
      const backupKeys = allKeys.filter((key: string) => key.startsWith(STORAGE_PREFIX));

      if (backupKeys.length === 0) {
        console.log('💾 SessionStatePersistence: No existing backups found');
        return;
      }

      const backupData = await platformStorage.multiGet(backupKeys);
      let loadedCount = 0;

      for (const [key, value] of backupData) {
        if (value) {
          try {
            const backup: SessionStateBackup = JSON.parse(value);

            // Validate backup age
            const now = Date.now();
            if (now - backup.timestamp > this.config.maxBackupAge) {
              // Remove expired backup
              await platformStorage.removeItem(key);
              continue;
            }

            this.localStateCache.set(backup.sessionId, backup);
            loadedCount++;
          } catch (parseError) {
            console.warn(`💾 SessionStatePersistence: Failed to parse backup for key ${key}:`, parseError);
            // Remove corrupted backup
            await platformStorage.removeItem(key);
          }
        }
      }

      console.log(`💾 SessionStatePersistence: Loaded ${loadedCount} backups from storage`);

    } catch (error) {
      console.error('💾 SessionStatePersistence: Failed to load backups:', error);
    }
  }

  /**
   * Clean up old backups
   */
  private async cleanupOldBackups(): Promise<void> {
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [sessionId, backup] of this.localStateCache.entries()) {
      // Remove if too old
      if (now - backup.timestamp > this.config.maxBackupAge) {
        toRemove.push(sessionId);
      }
    }

    // Remove from cache and storage
    for (const sessionId of toRemove) {
      this.localStateCache.delete(sessionId);
      await platformStorage.removeItem(`${STORAGE_PREFIX}${sessionId}`);
    }

    if (toRemove.length > 0) {
      console.log(`💾 SessionStatePersistence: Cleaned up ${toRemove.length} old backups`);
    }
  }

  /**
   * Reconcile state after reconnection
   */
  private async reconcileState(): Promise<void> {
    try {
      console.log('💾 SessionStatePersistence: Starting state reconciliation');

      const currentSessions = storage.getState().sessions;
      const reconciledSessions: Session[] = [];

      for (const [sessionId, cachedBackup] of this.localStateCache.entries()) {
        const currentSession = currentSessions[sessionId];

        if (!currentSession) {
          // Session exists in backup but not in current state
          console.log(`💾 SessionStatePersistence: Restoring session ${sessionId} from backup`);
          reconciledSessions.push(cachedBackup.state);
          continue;
        }

        // Reconcile based on configuration
        const reconciledSession = await this.resolveSessionConflict(
          cachedBackup.state,
          currentSession,
          sessionId,
        );

        if (reconciledSession) {
          reconciledSessions.push(reconciledSession);
        }
      }

      // Apply reconciled sessions
      if (reconciledSessions.length > 0) {
        storage.getState().applySessions(reconciledSessions);
        console.log(`💾 SessionStatePersistence: Reconciled ${reconciledSessions.length} sessions`);
      }

    } catch (error) {
      console.error('💾 SessionStatePersistence: Failed to reconcile state:', error);
    }
  }

  /**
   * Resolve conflicts between local backup and remote state
   */
  private async resolveSessionConflict(
    localSession: Session,
    remoteSession: Session,
    sessionId: string,
  ): Promise<Session | null> {
    try {
      switch (this.config.conflictResolution) {
        case 'local':
          console.log(`💾 SessionStatePersistence: Using local state for session ${sessionId}`);
          return localSession;

        case 'remote':
          console.log(`💾 SessionStatePersistence: Using remote state for session ${sessionId}`);
          return remoteSession;

        case 'merge':
        default:
          // Merge strategy: prefer more recent data per field
          const merged: Session = {
            ...remoteSession, // Start with remote as base

            // Use local data if it's more recent
            updatedAt: Math.max(localSession.updatedAt || 0, remoteSession.updatedAt || 0),
            activeAt: Math.max(localSession.activeAt || 0, remoteSession.activeAt || 0),
            thinkingAt: Math.max(localSession.thinkingAt || 0, remoteSession.thinkingAt || 0),

            // Merge metadata if local is newer
            metadata: localSession.metadataVersion && remoteSession.metadataVersion &&
                     localSession.metadataVersion > remoteSession.metadataVersion
              ? localSession.metadata
              : remoteSession.metadata,

            metadataVersion: Math.max(localSession.metadataVersion || 0, remoteSession.metadataVersion || 0),

            // Merge agent state if local is newer
            agentState: localSession.agentStateVersion && remoteSession.agentStateVersion &&
                       localSession.agentStateVersion > remoteSession.agentStateVersion
              ? localSession.agentState
              : remoteSession.agentState,

            agentStateVersion: Math.max(localSession.agentStateVersion || 0, remoteSession.agentStateVersion || 0),

            // Preserve local permission and model modes
            permissionMode: localSession.permissionMode || remoteSession.permissionMode,
            modelMode: localSession.modelMode || remoteSession.modelMode,

            // Prefer local thinking state if more recent
            thinking: localSession.thinkingAt && remoteSession.thinkingAt &&
                     localSession.thinkingAt > remoteSession.thinkingAt
              ? localSession.thinking
              : remoteSession.thinking,
          };

          console.log(`💾 SessionStatePersistence: Merged local and remote state for session ${sessionId}`);
          return merged;
      }
    } catch (error) {
      console.error(`💾 SessionStatePersistence: Failed to resolve conflict for session ${sessionId}:`, error);
      // Default to remote state on error
      return remoteSession;
    }
  }

  /**
   * Setup listeners for connection events
   */
  private setupConnectionListeners(): void {
    // Listen for reconnection events
    apiSocket.onReconnected(() => {
      console.log('💾 SessionStatePersistence: Connection restored, starting reconciliation');
      // Wait a bit for initial sync to complete
      setTimeout(() => {
        this.reconcileState();
      }, 2000);
    });
  }

  /**
   * Get persistence statistics
   */
  getStatistics(): {
    isRunning: boolean;
    lastBackupTime: number;
    backupCount: number;
    config: SessionStatePersistenceConfig;
    } {
    return {
      isRunning: this.isRunning,
      lastBackupTime: this.lastBackupTime,
      backupCount: this.localStateCache.size,
      config: { ...this.config },
    };
  }
}

// Global singleton instance
export const sessionStatePersistence = new SessionStatePersistence();

// Auto-start persistence when sync initializes
let isPersistenceStarted = false;

export function startSessionStatePersistence(): void {
  if (!isPersistenceStarted) {
    sessionStatePersistence.start();
    isPersistenceStarted = true;
  }
}

export function stopSessionStatePersistence(): void {
  if (isPersistenceStarted) {
    sessionStatePersistence.stop();
    isPersistenceStarted = false;
  }
}