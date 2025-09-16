/**
 * Enhanced session state persistence system
 * Provides continuous backup and recovery of session state during network interruptions
 */

import { storage } from './storage';
import { apiSocket } from './apiSocket';
import type { Session } from './storageTypes';
import AsyncStorage from '@react-native-async-storage/async-storage';

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
  conflictResolution: 'merge'
};

const STORAGE_PREFIX = 'session_backup_';

export class SessionStatePersistence {
  private config: SessionStatePersistenceConfig;
  private backupInterval: NodeJS.Timeout | null = null;
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
    await AsyncStorage.removeItem(`${STORAGE_PREFIX}${sessionId}`);
  }

  /**
   * Clear all backups
   */
  async clearAllBackups(): Promise<void> {
    const keys = Array.from(this.localStateCache.keys());
    this.localStateCache.clear();

    // Remove from AsyncStorage
    const storageKeys = keys.map(sessionId => `${STORAGE_PREFIX}${sessionId}`);
    await AsyncStorage.multiRemove(storageKeys);
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
          session.thinkingAt || 0
        );

        const timeSinceActivity = now - lastActivity;
        if (timeSinceActivity > this.config.maxBackupAge) {
          continue; // Skip very old sessions
        }

        const backup: SessionStateBackup = {
          sessionId,
          state: { ...session },
          timestamp: now,
          version: session.metadataVersion || 0
        };

        // Update cache
        this.localStateCache.set(sessionId, backup);

        // Prepare for storage
        backupsToSave.push({
          key: `${STORAGE_PREFIX}${sessionId}`,
          value: JSON.stringify(backup)
        });
      }

      // Save to AsyncStorage
      if (backupsToSave.length > 0) {
        const keyValuePairs = backupsToSave.map(item => [item.key, item.value] as [string, string]);
        await AsyncStorage.multiSet(keyValuePairs);
      }

      // Clean up old backups
      await this.cleanupOldBackups();

      console.log(`💾 SessionStatePersistence: Backed up ${backupsToSave.length} sessions`);

    } catch (error) {
      console.error('💾 SessionStatePersistence: Failed to backup state:', error);
    }
  }

  /**
   * Load backups from AsyncStorage
   */
  private async loadBackupsFromStorage(): Promise<void> {
    try {
      const allKeys = await AsyncStorage.getAllKeys();
      const backupKeys = allKeys.filter(key => key.startsWith(STORAGE_PREFIX));

      if (backupKeys.length === 0) {
        console.log('💾 SessionStatePersistence: No existing backups found');
        return;
      }

      const backupData = await AsyncStorage.multiGet(backupKeys);
      let loadedCount = 0;

      for (const [key, value] of backupData) {
        if (value) {
          try {
            const backup: SessionStateBackup = JSON.parse(value);

            // Validate backup age
            const now = Date.now();
            if (now - backup.timestamp > this.config.maxBackupAge) {
              // Remove expired backup
              await AsyncStorage.removeItem(key);
              continue;
            }

            this.localStateCache.set(backup.sessionId, backup);
            loadedCount++;
          } catch (parseError) {
            console.warn(`💾 SessionStatePersistence: Failed to parse backup for key ${key}:`, parseError);
            // Remove corrupted backup
            await AsyncStorage.removeItem(key);
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
      await AsyncStorage.removeItem(`${STORAGE_PREFIX}${sessionId}`);
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
          sessionId
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
    sessionId: string
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
                     : remoteSession.thinking
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
      config: { ...this.config }
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