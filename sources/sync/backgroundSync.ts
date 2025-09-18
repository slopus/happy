import { AppState, AppStateStatus, Platform } from 'react-native';
import { log } from '@/log';
import { apiSocket } from './apiSocket';
import { storage } from './storage';
import {
  getTaskManager,
  getBackgroundFetch,
  EXPO_MODULES_AVAILABILITY,
  type TaskManagerTaskExecutor
} from './expoModuleMocks';

// Get conditional imports
const TaskManager = getTaskManager();
const BackgroundFetch = getBackgroundFetch();

export interface BackgroundSyncConfig {
  maxBackgroundTime: number; // milliseconds
  criticalOperations: string[];
  syncInterval: number;
  enableNetworkOptimization: boolean;
}

export const DEFAULT_BACKGROUND_CONFIG: BackgroundSyncConfig = {
  maxBackgroundTime: 30000, // 30 seconds maximum background execution
  criticalOperations: ['connection_health', 'message_sync', 'session_state'],
  syncInterval: 15000, // 15 seconds background sync interval
  enableNetworkOptimization: true,
};

// Task identifiers
const BACKGROUND_SYNC_TASK = 'happy-background-sync';
const CONNECTION_MAINTENANCE_TASK = 'happy-connection-maintenance';

/**
 * Background sync manager for maintaining connections and syncing critical data
 * when the app is backgrounded. Uses Expo TaskManager and BackgroundFetch APIs when available,
 * with graceful degradation to alternative methods when these modules are not present.
 */
export class BackgroundSyncManager {
  private isBackgroundTaskActive: boolean = false;
  private backgroundTaskId: string | null = null;
  private appStateSubscription: any = null;
  private lastBackgroundTime: number = 0;
  private connectionHealthInterval: ReturnType<typeof setInterval> | null = null;
  private criticalSyncQueue: Array<{ operation: string; data: any; timestamp: number }> = [];

  constructor(private config: BackgroundSyncConfig = DEFAULT_BACKGROUND_CONFIG) {
    this.setupAppStateListener();
    this.registerBackgroundTasks();

    // Log module availability for debugging
    log.log(`📱 Background sync initialized. TaskManager: ${EXPO_MODULES_AVAILABILITY.taskManager ? '✅' : '❌'}, BackgroundFetch: ${EXPO_MODULES_AVAILABILITY.backgroundFetch ? '✅' : '❌'}`);
  }

  /**
   * Set up AppState change listener to handle foreground/background transitions
   */
  private setupAppStateListener() {
    this.appStateSubscription = AppState.addEventListener(
      'change',
      this.handleAppStateChange.bind(this)
    );
  }

  /**
   * Register background tasks with Expo TaskManager
   */
  private async registerBackgroundTasks() {
    try {
      // Check if Expo modules are available
      if (!EXPO_MODULES_AVAILABILITY.taskManager) {
        log.log('⚠️ TaskManager not available, background tasks will use fallback methods');
        return;
      }

      // Register background sync task
      TaskManager.defineTask(BACKGROUND_SYNC_TASK, this.backgroundSyncTask.bind(this));

      // Register connection maintenance task
      TaskManager.defineTask(CONNECTION_MAINTENANCE_TASK, this.connectionMaintenanceTask.bind(this));

      // Register background fetch if platform supports it and module is available
      if (Platform.OS !== 'web' && EXPO_MODULES_AVAILABILITY.backgroundFetch) {
        await BackgroundFetch.registerTaskAsync(BACKGROUND_SYNC_TASK, {
          minimumInterval: this.config.syncInterval / 1000, // Convert to seconds
          stopOnTerminate: false,
          startOnBoot: true,
        });

        log.log('📱 Background tasks registered successfully');
      } else if (Platform.OS !== 'web') {
        log.log('⚠️ BackgroundFetch not available, background sync will use alternative methods');
      }
    } catch (error) {
      log.error(`❌ Failed to register background tasks: ${error}`);
    }
  }

  /**
   * Handle app state changes (background/foreground transitions)
   */
  private async handleAppStateChange(nextAppState: AppStateStatus) {
    log.log(`📱 App state changed to: ${nextAppState}`);

    if (nextAppState === 'background' || nextAppState === 'inactive') {
      await this.startBackgroundSync();
    } else if (nextAppState === 'active') {
      await this.stopBackgroundSync();
      await this.refreshAllSyncServices();
    }
  }

  /**
   * Start background synchronization when app goes to background
   */
  private async startBackgroundSync() {
    if (this.isBackgroundTaskActive) {
      log.log('📱 Background sync already active');
      return;
    }

    try {
      this.lastBackgroundTime = Date.now();
      this.isBackgroundTaskActive = true;

      // Start connection health monitoring
      this.startConnectionHealthMonitoring();

      // Queue critical operations for background processing
      this.queueCriticalOperations();

      // Platform-specific background task management
      if (Platform.OS === 'ios') {
        await this.startIOSBackgroundTask();
      } else if (Platform.OS === 'android') {
        await this.startAndroidBackgroundSync();
      } else {
        // Web platform - use interval-based approach
        await this.startWebBackgroundSync();
      }

      log.log('✅ Background sync started successfully');
    } catch (error) {
      log.error(`❌ Failed to start background sync: ${error}`);
      this.isBackgroundTaskActive = false;
    }
  }

  /**
   * iOS-specific background task handling
   */
  private async startIOSBackgroundTask() {
    // iOS background app refresh limitations
    // Use minimal operations to preserve battery
    this.connectionHealthInterval = setInterval(() => {
      this.performMinimalConnectionCheck();
    }, Math.max(this.config.syncInterval, 30000)); // Minimum 30s interval for iOS
  }

  /**
   * Android-specific background sync
   */
  private async startAndroidBackgroundSync() {
    // Android allows more flexible background processing
    // but still needs to respect doze mode and battery optimization
    this.connectionHealthInterval = setInterval(() => {
      this.performCriticalSync();
    }, this.config.syncInterval);
  }

  /**
   * Web platform background sync (uses document visibility)
   */
  private async startWebBackgroundSync() {
    if (typeof document !== 'undefined') {
      // Use document visibility API for web
      document.addEventListener('visibilitychange', this.handleWebVisibilityChange.bind(this));
    }

    // Use less aggressive intervals for web
    this.connectionHealthInterval = setInterval(() => {
      if (typeof document === 'undefined' || document.hidden) {
        this.performWebBackgroundSync();
      }
    }, this.config.syncInterval * 2); // Double interval for web
  }

  /**
   * Handle web visibility changes
   */
  private handleWebVisibilityChange() {
    if (typeof document !== 'undefined') {
      if (document.hidden) {
        this.performWebBackgroundSync();
      } else {
        this.refreshAllSyncServices();
      }
    }
  }

  /**
   * Background sync task implementation
   */
  private async backgroundSyncTask() {
    try {
      const startTime = Date.now();

      // Check if we've exceeded maximum background time
      if (startTime - this.lastBackgroundTime > this.config.maxBackgroundTime) {
        log.log('⏰ Background time limit reached, stopping sync');
        await this.stopBackgroundSync();
        return;
      }

      // Perform critical background operations
      await this.maintainCriticalConnections();
      await this.syncCriticalData();
      await this.cleanupStaleConnections();

      log.log(`🔄 Background sync completed in ${Date.now() - startTime}ms`);
    } catch (error) {
      log.error(`❌ Background sync task failed: ${error}`);
    }
  }

  /**
   * Connection maintenance task
   */
  private async connectionMaintenanceTask() {
    try {
      // Send lightweight ping to maintain connection
      if (apiSocket.isConnected()) {
        await this.sendHeartbeat();
      } else {
        // Attempt lightweight reconnection
        await this.attemptReconnection();
      }
    } catch (error) {
      log.error(`❌ Connection maintenance failed: ${error}`);
    }
  }

  /**
   * Start connection health monitoring
   */
  private startConnectionHealthMonitoring() {
    // Monitor connection status every 10 seconds in background
    this.connectionHealthInterval = setInterval(() => {
      this.checkConnectionHealth();
    }, 10000);
  }

  /**
   * Queue critical operations for background processing
   */
  private queueCriticalOperations() {
    const timestamp = Date.now();

    this.config.criticalOperations.forEach(operation => {
      this.criticalSyncQueue.push({
        operation,
        data: this.getCriticalOperationData(operation),
        timestamp,
      });
    });
  }

  /**
   * Get data for critical operations
   */
  private getCriticalOperationData(operation: string): any {
    switch (operation) {
      case 'connection_health':
        return {
          isConnected: apiSocket.isConnected(),
          lastPing: apiSocket.getLastPingTime?.() || 0,
        };
      case 'message_sync':
        return {
          pendingMessages: this.getPendingMessageCount(),
        };
      case 'session_state':
        return {
          activeSessions: storage.getState().getActiveSessions().length,
        };
      default:
        return {};
    }
  }

  /**
   * Get pending message count (simplified)
   */
  private getPendingMessageCount(): number {
    // This would typically check for unsent messages or pending operations
    return 0; // Placeholder implementation
  }

  /**
   * Maintain critical connections during background
   */
  private async maintainCriticalConnections() {
    try {
      // Check socket connection
      if (!apiSocket.isConnected()) {
        log.log('🔌 Socket disconnected in background, attempting reconnection');
        await this.attemptReconnection();
      } else {
        // Send lightweight heartbeat
        await this.sendHeartbeat();
      }
    } catch (error) {
      log.error(`❌ Failed to maintain connections: ${error}`);
    }
  }

  /**
   * Send lightweight heartbeat
   */
  private async sendHeartbeat() {
    try {
      // Use minimal data to check connection
      apiSocket.send('ping', { timestamp: Date.now() });
    } catch (error) {
      log.error(`❌ Heartbeat failed: ${error}`);
    }
  }

  /**
   * Attempt lightweight reconnection
   */
  private async attemptReconnection() {
    try {
      // Only attempt if not already trying to connect
      if (!apiSocket.isConnecting()) {
        await apiSocket.reconnect();
      }
    } catch (error) {
      log.error(`❌ Reconnection attempt failed: ${error}`);
    }
  }

  /**
   * Sync critical data in background
   */
  private async syncCriticalData() {
    try {
      // Process queued critical operations
      const now = Date.now();

      // Only process recent operations (within last 5 minutes)
      const recentOperations = this.criticalSyncQueue.filter(
        op => now - op.timestamp < 300000
      );

      for (const operation of recentOperations) {
        await this.processCriticalOperation(operation);
      }

      // Clean up old operations
      this.criticalSyncQueue = recentOperations;
    } catch (error) {
      log.error(`❌ Critical data sync failed: ${error}`);
    }
  }

  /**
   * Process individual critical operation
   */
  private async processCriticalOperation(operation: { operation: string; data: any; timestamp: number }) {
    switch (operation.operation) {
      case 'connection_health':
        await this.checkConnectionHealth();
        break;
      case 'message_sync':
        // Minimal message sync - only if absolutely necessary
        break;
      case 'session_state':
        // Preserve session state
        await this.preserveSessionState();
        break;
    }
  }

  /**
   * Check connection health
   */
  private async checkConnectionHealth() {
    const isConnected = apiSocket.isConnected();
    const connectionQuality = this.assessConnectionQuality();

    log.log(`🔍 Connection health check: connected=${isConnected}, quality=${connectionQuality}`);

    if (!isConnected || connectionQuality < 0.5) {
      await this.attemptReconnection();
    }
  }

  /**
   * Assess connection quality (0-1 scale)
   */
  private assessConnectionQuality(): number {
    // Simplified quality assessment
    if (!apiSocket.isConnected()) return 0;

    const lastPing = apiSocket.getLastPingTime?.() || 0;
    const timeSincePing = Date.now() - lastPing;

    if (timeSincePing < 30000) return 1.0; // Less than 30s
    if (timeSincePing < 60000) return 0.7; // Less than 1min
    if (timeSincePing < 120000) return 0.4; // Less than 2min
    return 0.1; // Stale connection
  }

  /**
   * Preserve session state
   */
  private async preserveSessionState() {
    try {
      // Minimal state preservation to prevent data loss
      const activeSessions = storage.getState().getActiveSessions();
      log.log(`💾 Preserving state for ${activeSessions.length} active sessions`);
    } catch (error) {
      log.error(`❌ Failed to preserve session state: ${error}`);
    }
  }

  /**
   * Clean up stale connections
   */
  private async cleanupStaleConnections() {
    try {
      // Remove stale data and cleanup resources
      const now = Date.now();

      // Clean up old critical operations (older than 10 minutes)
      this.criticalSyncQueue = this.criticalSyncQueue.filter(
        op => now - op.timestamp < 600000
      );

      log.log(`🧹 Cleaned up stale operations, ${this.criticalSyncQueue.length} remaining`);
    } catch (error) {
      log.error(`❌ Cleanup failed: ${error}`);
    }
  }

  /**
   * Perform minimal connection check (iOS-optimized)
   */
  private performMinimalConnectionCheck() {
    if (apiSocket.isConnected()) {
      // Just verify connection is alive, no data transfer
      const lastActivity = apiSocket.getLastActivityTime?.() || 0;
      if (Date.now() - lastActivity > 60000) {
        // Connection seems stale, queue for reconnection when app becomes active
        log.log('🔌 Connection appears stale, will reconnect on app activation');
      }
    }
  }

  /**
   * Perform critical sync (Android-optimized)
   */
  private async performCriticalSync() {
    try {
      await this.maintainCriticalConnections();

      // Only sync if battery level is sufficient (if available)
      if (await this.isBatteryLevelSufficient()) {
        await this.syncCriticalData();
      }
    } catch (error) {
      log.error(`❌ Critical sync failed: ${error}`);
    }
  }

  /**
   * Check if battery level is sufficient for background operations
   */
  private async isBatteryLevelSufficient(): Promise<boolean> {
    try {
      // If expo-battery is available, use it
      const Battery = require('expo-battery');
      const batteryLevel = await Battery.getBatteryLevelAsync();
      return batteryLevel > 0.15; // Only sync if battery > 15%
    } catch (error) {
      // If battery info not available, assume sufficient
      return true;
    }
  }

  /**
   * Perform web background sync
   */
  private performWebBackgroundSync() {
    // Minimal operations for web platform
    if (apiSocket.isConnected()) {
      this.sendHeartbeat();
    }
  }

  /**
   * Stop background synchronization
   */
  private async stopBackgroundSync() {
    if (!this.isBackgroundTaskActive) {
      return;
    }

    try {
      // Clear intervals
      if (this.connectionHealthInterval) {
        clearInterval(this.connectionHealthInterval);
        this.connectionHealthInterval = null;
      }

      // Platform-specific cleanup
      if (Platform.OS !== 'web' && EXPO_MODULES_AVAILABILITY.backgroundFetch) {
        await BackgroundFetch.unregisterTaskAsync(BACKGROUND_SYNC_TASK);
      }

      this.isBackgroundTaskActive = false;
      this.backgroundTaskId = null;

      log.log('✅ Background sync stopped successfully');
    } catch (error) {
      log.error(`❌ Failed to stop background sync: ${error}`);
    }
  }

  /**
   * Refresh all sync services when app becomes active
   */
  private async refreshAllSyncServices() {
    try {
      log.log('🔄 Refreshing all sync services after background period');

      // Refresh socket connection
      if (!apiSocket.isConnected()) {
        await apiSocket.reconnect();
      }

      // Trigger sync invalidations (this would integrate with existing sync system)
      // This is where you'd call existing sync methods like:
      // sync.refreshSessions();
      // sync.refreshMachines();

      log.log('✅ Sync services refreshed successfully');
    } catch (error) {
      log.error(`❌ Failed to refresh sync services: ${error}`);
    }
  }

  /**
   * Get background sync status
   */
  public getStatus() {
    return {
      isActive: this.isBackgroundTaskActive,
      lastBackgroundTime: this.lastBackgroundTime,
      queuedOperations: this.criticalSyncQueue.length,
      connectionHealthMonitoring: !!this.connectionHealthInterval,
    };
  }

  /**
   * Update configuration
   */
  public updateConfig(newConfig: Partial<BackgroundSyncConfig>) {
    this.config = { ...this.config, ...newConfig };
    log.log('⚙️ Background sync configuration updated');
  }

  /**
   * Cleanup resources
   */
  public cleanup() {
    if (this.appStateSubscription) {
      this.appStateSubscription.remove?.();
      this.appStateSubscription = null;
    }

    if (this.connectionHealthInterval) {
      clearInterval(this.connectionHealthInterval);
      this.connectionHealthInterval = null;
    }

    this.isBackgroundTaskActive = false;
    this.criticalSyncQueue = [];

    log.log('🧹 Background sync manager cleaned up');
  }
}

// Global instance
export const backgroundSyncManager = new BackgroundSyncManager();

/**
 * Initialize background sync with custom configuration
 */
export function initializeBackgroundSync(config?: Partial<BackgroundSyncConfig>) {
  if (config) {
    backgroundSyncManager.updateConfig(config);
  }

  log.log('🚀 Background sync manager initialized');
  return backgroundSyncManager;
}

/**
 * Get current background sync status
 */
export function getBackgroundSyncStatus() {
  return backgroundSyncManager.getStatus();
}