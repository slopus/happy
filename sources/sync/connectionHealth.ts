/**
 * Enhanced connection health monitoring system
 * Provides real-time connection quality assessment and proactive monitoring
 */

import { apiSocket } from './apiSocket';
import { storage } from './storage';
import { connectionStateMachine, ConnectionState, type StateTransitionEvent } from './connectionStateMachine';
import { log } from '@/log';
import { 
  CONNECTION_INTERVALS, 
  CONNECTION_TIMEOUTS, 
  CONNECTION_THRESHOLDS, 
  CONNECTION_LIMITS 
} from './config/ConnectionConstants';
import { TimerManager } from './utils/TimerManager';
import { ErrorHandler, TimeoutError } from './utils/ErrorHandler';

export type ConnectionQuality = 'excellent' | 'good' | 'poor' | 'failed' | 'unknown';

export interface ConnectionHealthStatus {
  quality: ConnectionQuality;
  state: ConnectionState;
  latency: number | null;
  lastSuccessfulPing: number | null;
  consecutiveFailures: number;
  uptime: number;
  downtime: number;
}

export interface HeartbeatProfile {
  interval: number;
  timeout: number;
  maxConsecutiveFailures: number;
}

export const HEARTBEAT_PROFILES = {
  standard: {
    interval: CONNECTION_INTERVALS.HEARTBEAT_STANDARD,
    timeout: CONNECTION_TIMEOUTS.PING_TIMEOUT,
    maxConsecutiveFailures: CONNECTION_THRESHOLDS.MAX_CONSECUTIVE_FAILURES_STANDARD,
  } as HeartbeatProfile,
  aggressive: {
    interval: CONNECTION_INTERVALS.HEARTBEAT_AGGRESSIVE,
    timeout: CONNECTION_TIMEOUTS.HEALTH_CHECK_TIMEOUT,
    maxConsecutiveFailures: CONNECTION_THRESHOLDS.MAX_CONSECUTIVE_FAILURES_AGGRESSIVE,
  } as HeartbeatProfile,
  corporate: {
    interval: CONNECTION_INTERVALS.HEARTBEAT_CORPORATE,
    timeout: 3000, // 3 seconds - most aggressive
    maxConsecutiveFailures: CONNECTION_THRESHOLDS.MAX_CONSECUTIVE_FAILURES_CORPORATE,
  } as HeartbeatProfile,
  battery_saver: {
    interval: CONNECTION_INTERVALS.HEARTBEAT_BATTERY_SAVER,
    timeout: 15000, // 15 seconds
    maxConsecutiveFailures: CONNECTION_THRESHOLDS.MAX_CONSECUTIVE_FAILURES_BATTERY_SAVER,
  } as HeartbeatProfile,
} as const;

export interface ConnectionHealthConfig {
  pingInterval: number;        // How often to ping (ms)
  pingTimeout: number;         // Ping timeout (ms)
  maxConsecutiveFailures: number; // Before marking as failed
  qualityThresholds: {
    excellent: number;         // < excellent latency
    good: number;             // < good latency
    poor: number;             // < poor latency (above = failed)
  };
}

const DEFAULT_CONFIG: ConnectionHealthConfig = {
  pingInterval: CONNECTION_INTERVALS.HEARTBEAT_STANDARD,
  pingTimeout: CONNECTION_TIMEOUTS.PING_TIMEOUT,
  maxConsecutiveFailures: CONNECTION_THRESHOLDS.MAX_CONSECUTIVE_FAILURES_STANDARD,
  qualityThresholds: {
    excellent: CONNECTION_THRESHOLDS.LATENCY_EXCELLENT,
    good: CONNECTION_THRESHOLDS.LATENCY_GOOD,
    poor: CONNECTION_THRESHOLDS.LATENCY_POOR,
  },
};

export class ConnectionHealthMonitor {
  private config: ConnectionHealthConfig;
  private status: ConnectionHealthStatus;
  private isRunning = false;
  private listeners = new Set<(status: ConnectionHealthStatus) => void>();
  private timerManager = new TimerManager('ConnectionHealthMonitor');

  // Timing tracking
  private connectionStartTime: number | null = null;
  private lastDisconnectTime: number | null = null;
  private totalDowntime = 0;

  // Profile management
  private currentProfile: keyof typeof HEARTBEAT_PROFILES = 'standard';

  // Auto-detection data with memory management
  private failureHistory: Array<{ timestamp: number; type: string }> = [];
  private latencyHistory: number[] = [];
  private networkChangeCount = 0;
  
  private cleanupOldData(): void {
    const oneHourAgo = Date.now() - CONNECTION_INTERVALS.FAILURE_CLEANUP_WINDOW;
    
    // Clean old failures
    this.failureHistory = this.failureHistory.filter(f => f.timestamp > oneHourAgo);
    
    // Keep latency history within limits
    if (this.latencyHistory.length > CONNECTION_LIMITS.MAX_LATENCY_HISTORY) {
      this.latencyHistory = this.latencyHistory.slice(-CONNECTION_LIMITS.MAX_LATENCY_HISTORY);
    }
    
    // Reset network change count periodically (every hour)
    const lastCleanup = this.getLastCleanupTime();
    if (Date.now() - lastCleanup > CONNECTION_INTERVALS.FAILURE_CLEANUP_WINDOW) {
      this.networkChangeCount = Math.max(0, this.networkChangeCount - 1);
      this.setLastCleanupTime(Date.now());
    }
  }
  
  private getLastCleanupTime(): number {
    // Could be stored in storage for persistence
    return this.lastCleanupTime || 0;
  }
  
  private setLastCleanupTime(time: number): void {
    this.lastCleanupTime = time;
  }
  
  private lastCleanupTime: number = 0;

  constructor(config: Partial<ConnectionHealthConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    this.status = {
      quality: 'unknown',
      state: ConnectionState.OFFLINE,
      latency: null,
      lastSuccessfulPing: null,
      consecutiveFailures: 0,
      uptime: 0,
      downtime: 0,
    };

    this.setupSocketListeners();
  }

  /**
   * Start connection health monitoring
   */
  start(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    log.info('Starting health monitoring', 'ConnectionHealthMonitor');

    // Start periodic ping checks using current profile interval
    const currentProfileData = HEARTBEAT_PROFILES[this.currentProfile];
    this.timerManager.setInterval(
      () => this.performHealthCheck(),
      currentProfileData.interval,
      'healthCheck',
      { name: 'Health Check Interval' }
    );

    // Perform initial health check
    this.performHealthCheck();
  }

  /**
   * Stop connection health monitoring
   */
  stop(): void {
    if (!this.isRunning) return;

    this.isRunning = false;
    log.info('Stopping health monitoring', 'ConnectionHealthMonitor');

    this.timerManager.clearAll();
  }

  /**
   * Get current connection health status
   */
  getStatus(): ConnectionHealthStatus {
    return { ...this.status };
  }

  /**
   * Add listener for status changes
   */
  addListener(listener: (status: ConnectionHealthStatus) => void): () => void {
    this.listeners.add(listener);
    // Immediately notify with current status
    listener(this.getStatus());

    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Manually trigger a health check
   */
  async checkNow(): Promise<ConnectionHealthStatus> {
    await this.performHealthCheck();
    return this.getStatus();
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<ConnectionHealthConfig>): void {
    this.config = { ...this.config, ...newConfig };

    // Restart with new config if running
    if (this.isRunning) {
      this.stop();
      this.start();
    }
  }

  /**
   * Set heartbeat profile
   */
  setProfile(profileName: keyof typeof HEARTBEAT_PROFILES): void {
    if (!HEARTBEAT_PROFILES[profileName]) {
      log.warn(`Unknown profile '${profileName}', falling back to 'standard'`, 'ConnectionHealthMonitor');
      this.currentProfile = 'standard';
      return;
    }

    this.currentProfile = profileName;

    // Restart monitoring with new profile if running
    if (this.isRunning) {
      this.stop();
      this.start();
    }
  }

  /**
   * Get current profile information
   */
  getCurrentProfile(): { name: keyof typeof HEARTBEAT_PROFILES; profile: HeartbeatProfile } {
    return {
      name: this.currentProfile,
      profile: HEARTBEAT_PROFILES[this.currentProfile],
    };
  }

  /**
   * Get all available profiles
   */
  getAvailableProfiles(): typeof HEARTBEAT_PROFILES {
    return HEARTBEAT_PROFILES;
  }

  /**
   * Auto-detect optimal profile based on connection conditions
   */
  autoDetectProfile(): keyof typeof HEARTBEAT_PROFILES {
    const recentFailures = this.getRecentFailures();
    const avgLatency = this.getAverageLatency();

    // Corporate profile for high failure rate or frequent network changes
    if (recentFailures >= 10 || this.networkChangeCount >= 5) {
      return 'corporate';
    }

    // Aggressive profile for moderate failures or high latency
    if (recentFailures >= 3 || avgLatency > 800) {
      return 'aggressive';
    }

    // Battery saver for very stable connections
    if (recentFailures === 0 && avgLatency < 200) {
      return 'battery_saver';
    }

    // Standard for normal conditions
    return 'standard';
  }

  /**
   * Apply auto-detected profile if different from current
   */
  applyAutoDetectedProfile(): void {
    const detectedProfile = this.autoDetectProfile();
    if (detectedProfile !== this.currentProfile) {
      this.setProfile(detectedProfile);
    }
  }

  /**
   * Perform a health check by pinging the server
   */
  private async performHealthCheck(): Promise<void> {
    // Don't ping if not connected
    if (this.status.state !== 'connected') {
      return;
    }

    const startTime = Date.now();
    const currentProfileData = HEARTBEAT_PROFILES[this.currentProfile];

    try {
      // Use a simple ping mechanism
      await this.pingServer();

      const latency = Date.now() - startTime;

      // Update successful ping metrics
      this.status.latency = latency;
      this.status.lastSuccessfulPing = Date.now();
      this.status.consecutiveFailures = 0;
      this.status.quality = this.calculateQuality(latency);

      // Track latency for auto-detection
      this.latencyHistory.push(latency);
      
      // Periodic cleanup
      this.cleanupOldData();

      // Trigger auto-detection periodically
      if (this.latencyHistory.length % 10 === 0 && this.latencyHistory.length > 0) {
        this.applyAutoDetectedProfile();
      }

      log.debug(`Ping successful - ${latency}ms (${this.status.quality})`, 'ConnectionHealthMonitor');

    } catch (error) {
      // Handle ping failure
      this.status.consecutiveFailures += 1;

      // Track failure for auto-detection
      this.failureHistory.push({
        timestamp: Date.now(),
        type: error instanceof Error ? error.message : 'unknown',
      });

      // Periodic cleanup
      this.cleanupOldData();

      log.warn(`Ping failed (${this.status.consecutiveFailures}/${currentProfileData.maxConsecutiveFailures})`, 'ConnectionHealthMonitor');

      // Update quality based on failure count using current profile
      if (this.status.consecutiveFailures >= currentProfileData.maxConsecutiveFailures) {
        this.status.quality = 'failed';
      } else {
        this.status.quality = 'poor';
      }
    }

    // Update uptime/downtime
    this.updateTimingMetrics();

    // Notify listeners
    this.notifyListeners();
  }

  /**
   * Ping the server using a lightweight method
   */
  private async pingServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const currentProfileData = HEARTBEAT_PROFILES[this.currentProfile];
      const timeout = setTimeout(() => {
        reject(new Error('Ping timeout'));
      }, currentProfileData.timeout);

      try {
        // Use socket.io ping mechanism if available
        if (apiSocket.isSocketConnected()) {
          const socket = apiSocket.getSocketInstance();

          if (socket) {
            // Send a ping and wait for pong
            socket.emit('ping', { timestamp: Date.now() });

            const handlePong = () => {
              clearTimeout(timeout);
              socket.off('pong', handlePong);
              resolve();
            };

            socket.once('pong', handlePong);
          } else {
            reject(new Error('Socket instance not available'));
          }
        } else {
          reject(new Error('Socket not connected'));
        }
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  /**
   * Calculate connection quality based on latency
   */
  private calculateQuality(latency: number): ConnectionQuality {
    const { excellent, good, poor } = this.config.qualityThresholds;

    if (latency < excellent) return 'excellent';
    if (latency < good) return 'good';
    if (latency < poor) return 'poor';
    return 'failed';
  }

  /**
   * Update uptime and downtime metrics
   */
  private updateTimingMetrics(): void {
    const now = Date.now();

    if (this.status.state === 'connected' && this.connectionStartTime) {
      this.status.uptime = now - this.connectionStartTime;
    }

    if (this.lastDisconnectTime) {
      this.status.downtime = this.totalDowntime + (this.connectionStartTime ? this.connectionStartTime - this.lastDisconnectTime : 0);
    }
  }

  /**
   * Get recent failures count for auto-detection
   */
  private getRecentFailures(): number {
    const tenMinutesAgo = Date.now() - (10 * 60 * 1000);
    return this.failureHistory.filter(f => f.timestamp > tenMinutesAgo).length;
  }

  /**
   * Get average latency for auto-detection
   */
  private getAverageLatency(): number {
    if (this.latencyHistory.length === 0) return 0;
    const sum = this.latencyHistory.reduce((a, b) => a + b, 0);
    return sum / this.latencyHistory.length;
  }

  /**
   * Setup listeners for socket connection events and state machine
   */
  private setupSocketListeners(): void {
    // Listen to state machine changes
    connectionStateMachine.addStateChangeListener((state, context, event) => {
      this.status.state = state as any; // Map ConnectionState to our local type
      this.status.consecutiveFailures = context.consecutiveFailures;

      // Update timing based on state machine context
      this.status.uptime = context.totalUptime;
      this.status.downtime = context.totalDowntime;

      if (context.lastConnectedAt) {
        this.connectionStartTime = context.lastConnectedAt;
      }
      if (context.lastDisconnectedAt) {
        this.lastDisconnectTime = context.lastDisconnectedAt;
      }

      log.debug(`State machine updated: ${state} (${event.type})`, 'ConnectionHealthMonitor');
      this.notifyListeners();
    });

    // Listen to socket events and forward to state machine
    apiSocket.onStatusChange((socketStatus) => {
      const now = Date.now();
      let event: StateTransitionEvent;

      // Track network changes for auto-detection
      this.networkChangeCount++;

      switch (socketStatus) {
        case 'disconnected':
          event = { type: 'disconnect', timestamp: now };
          this.status.quality = 'unknown';
          break;

        case 'connecting':
          event = { type: 'connect', timestamp: now };
          this.status.quality = 'unknown';
          break;

        case 'connected':
          event = { type: 'connect', timestamp: now };
          this.status.consecutiveFailures = 0;
          break;

        case 'error':
          event = { type: 'failure', timestamp: now, error: new Error('Socket error') };
          this.status.quality = 'failed';
          break;

        default:
          return; // Unknown status
      }

      connectionStateMachine.transition(event);
    });

    apiSocket.onReconnected(() => {
      log.info('Reconnection detected', 'ConnectionHealthMonitor');
      const event: StateTransitionEvent = {
        type: 'connect',
        timestamp: Date.now(),
      };
      connectionStateMachine.transition(event);
    });
  }

  /**
   * Notify all listeners of status changes
   */
  private notifyListeners(): void {
    const status = this.getStatus();
    this.listeners.forEach(listener => {
      try {
        listener(status);
      } catch (error) {
        log.error('Error in listener', 'ConnectionHealthMonitor', error as Error);
      }
    });
  }

  /**
   * Get a human-readable description of the current connection status
   */
  getStatusDescription(): string {
    const { state, quality, latency, consecutiveFailures } = this.status;

    switch (state) {
      case 'offline':
        return 'Offline';
      case 'connecting':
        return 'Connecting...';
      case 'failed':
        return `Connection Failed (${consecutiveFailures} failures)`;
      case 'connected':
        if (latency !== null) {
          return `Connected (${latency}ms, ${quality})`;
        }
        return 'Connected';
      default:
        return 'Unknown';
    }
  }

  /**
   * Get connection quality color for UI
   */
  getQualityColor(): string {
    switch (this.status.quality) {
      case 'excellent':
        return '#34C759'; // Green
      case 'good':
        return '#32D74B'; // Light green
      case 'poor':
        return '#FF9500'; // Orange
      case 'failed':
        return '#FF3B30'; // Red
      default:
        return '#8E8E93'; // Gray
    }
  }
}

// Global singleton instance
export const connectionHealthMonitor = new ConnectionHealthMonitor();

// Auto-start monitoring when sync initializes
let isMonitoringStarted = false;

export function startConnectionHealthMonitoring(): void {
  if (!isMonitoringStarted) {
    connectionHealthMonitor.start();
    isMonitoringStarted = true;
  }
}

export function stopConnectionHealthMonitoring(): void {
  if (isMonitoringStarted) {
    connectionHealthMonitor.stop();
    isMonitoringStarted = false;
  }
}