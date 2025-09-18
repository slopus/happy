/**
 * Enhanced connection health monitoring system
 * Provides real-time connection quality assessment and proactive monitoring
 */

import { apiSocket } from './apiSocket';
import { storage } from './storage';
import { connectionStateMachine, ConnectionState, type StateTransitionEvent } from './connectionStateMachine';
import { log } from '@/log';

export type ConnectionQuality = 'excellent' | 'good' | 'poor' | 'failed' | 'unknown';

export interface HeartbeatProfile {
  interval: number;
  timeout: number;
  maxConsecutiveFailures: number;
  description: string;
}

export const HEARTBEAT_PROFILES: Record<string, HeartbeatProfile> = {
  standard: {
    interval: 30000,
    timeout: 10000,
    maxConsecutiveFailures: 3,
    description: 'Default profile for stable networks'
  },
  aggressive: {
    interval: 15000,
    timeout: 5000,
    maxConsecutiveFailures: 2,
    description: 'Faster detection for unstable networks'
  },
  corporate: {
    interval: 10000,
    timeout: 3000,
    maxConsecutiveFailures: 1,
    description: 'Aggressive profile for strict firewalls'
  },
  battery_saver: {
    interval: 60000,
    timeout: 15000,
    maxConsecutiveFailures: 5,
    description: 'Reduced frequency for battery conservation'
  }
};

export interface ConnectionHealthStatus {
  quality: ConnectionQuality;
  state: ConnectionState;
  latency: number | null;
  lastSuccessfulPing: number | null;
  consecutiveFailures: number;
  uptime: number;
  downtime: number;
}

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
  pingInterval: 30000,        // 30 seconds
  pingTimeout: 10000,         // 10 seconds
  maxConsecutiveFailures: 3,
  qualityThresholds: {
    excellent: 100,           // < 100ms
    good: 500,               // < 500ms
    poor: 2000,               // < 2000ms
  },
};

export class ConnectionHealthMonitor {
  private config: ConnectionHealthConfig;
  private status: ConnectionHealthStatus;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private listeners = new Set<(status: ConnectionHealthStatus) => void>();

  // Timing tracking
  private connectionStartTime: number | null = null;
  private lastDisconnectTime: number | null = null;
  private totalDowntime = 0;

  // Heartbeat profile management
  private currentProfile: HeartbeatProfile;
  private currentProfileName: keyof typeof HEARTBEAT_PROFILES = 'standard';

  // Auto-detection state
  private failureHistory: Array<{ timestamp: number; type: string }> = [];
  private latencyHistory: number[] = [];
  private networkChangeCount = 0;

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

    // Initialize with standard profile
    this.currentProfile = HEARTBEAT_PROFILES.standard;

    this.setupSocketListeners();
  }

  /**
   * Start connection health monitoring
   */
  start(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    log.log('🏥 ConnectionHealthMonitor: Starting health monitoring');

    // Start periodic ping checks using current profile interval
    this.pingInterval = setInterval(() => {
      this.performHealthCheck();
    }, this.currentProfile.interval);

    // Perform initial health check
    this.performHealthCheck();
  }

  /**
   * Stop connection health monitoring
   */
  stop(): void {
    if (!this.isRunning) return;

    this.isRunning = false;
    log.log('🏥 ConnectionHealthMonitor: Stopping health monitoring');

    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
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
    try {
      await this.performHealthCheck();
    } catch (error) {
      log.error(`🏥 ConnectionHealthMonitor: Error in manual health check: ${error instanceof Error ? error.message : String(error)}`);
    }
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
   * Set heartbeat profile for different network conditions
   */
  setProfile(profileName: keyof typeof HEARTBEAT_PROFILES): void {
    if (!HEARTBEAT_PROFILES[profileName]) {
      log.error(`🏥 ConnectionHealthMonitor: Unknown profile '${profileName}', using 'standard'`);
      profileName = 'standard';
    }

    const oldProfile = this.currentProfileName;
    this.currentProfile = HEARTBEAT_PROFILES[profileName];
    this.currentProfileName = profileName;

    log.log(`🏥 ConnectionHealthMonitor: Profile changed from '${oldProfile}' to '${profileName}'`);
    log.log(`🏥 Profile settings: interval=${this.currentProfile.interval}ms, timeout=${this.currentProfile.timeout}ms, maxFailures=${this.currentProfile.maxConsecutiveFailures}`);

    // Apply new profile settings
    this.reconfigureHeartbeat();
  }

  /**
   * Get current heartbeat profile information
   */
  getCurrentProfile(): { name: keyof typeof HEARTBEAT_PROFILES; profile: HeartbeatProfile } {
    return {
      name: this.currentProfileName,
      profile: { ...this.currentProfile }
    };
  }

  /**
   * Get all available heartbeat profiles
   */
  getAvailableProfiles(): Record<string, HeartbeatProfile> {
    return { ...HEARTBEAT_PROFILES };
  }

  /**
   * Auto-detect optimal profile based on network conditions and failure patterns
   */
  autoDetectProfile(): keyof typeof HEARTBEAT_PROFILES {
    const now = Date.now();
    const recentWindow = 5 * 60 * 1000; // 5 minutes

    // Filter recent failures and latency data
    const recentFailures = this.failureHistory.filter(f => now - f.timestamp < recentWindow);
    const recentLatency = this.latencyHistory.slice(-10); // Last 10 measurements

    // Calculate failure rate
    const totalChecks = Math.max(10, recentLatency.length + recentFailures.length);
    const failureRate = recentFailures.length / totalChecks;

    // Calculate average latency
    const avgLatency = recentLatency.length > 0
      ? recentLatency.reduce((sum, lat) => sum + lat, 0) / recentLatency.length
      : 0;

    // Count network changes in recent history
    const recentNetworkChanges = this.networkChangeCount;

    log.log(`🏥 Auto-detection metrics: failureRate=${failureRate.toFixed(2)}, avgLatency=${avgLatency.toFixed(0)}ms, networkChanges=${recentNetworkChanges}`);

    // Decision logic for profile selection
    if (failureRate > 0.3 || recentNetworkChanges > 3) {
      // High failure rate or frequent network changes - use corporate profile
      return 'corporate';
    } else if (failureRate > 0.15 || avgLatency > 1000) {
      // Moderate failure rate or high latency - use aggressive profile
      return 'aggressive';
    } else if (failureRate < 0.05 && avgLatency < 200 && recentFailures.length === 0) {
      // Very stable connection - use battery saver
      return 'battery_saver';
    } else {
      // Normal conditions - use standard profile
      return 'standard';
    }
  }

  /**
   * Automatically apply the optimal profile based on current conditions
   */
  applyAutoDetectedProfile(): void {
    const optimalProfile = this.autoDetectProfile();
    if (optimalProfile !== this.currentProfileName) {
      log.log(`🏥 ConnectionHealthMonitor: Auto-switching to '${optimalProfile}' profile`);
      this.setProfile(optimalProfile);
    }
  }

  /**
   * Reconfigure heartbeat timing based on current profile
   */
  private reconfigureHeartbeat(): void {
    // Update config to match current profile
    this.config.pingInterval = this.currentProfile.interval;
    this.config.pingTimeout = this.currentProfile.timeout;
    this.config.maxConsecutiveFailures = this.currentProfile.maxConsecutiveFailures;

    // If monitoring is running, restart with new timing
    if (this.isRunning && this.pingInterval) {
      log.log(`🏥 ConnectionHealthMonitor: Reconfiguring heartbeat with new intervals`);

      // Clear existing interval
      clearInterval(this.pingInterval);

      // Start new interval with current profile settings
      this.pingInterval = setInterval(() => {
        this.performHealthCheck();
      }, this.currentProfile.interval);

      log.log(`🏥 ConnectionHealthMonitor: Heartbeat reconfigured - interval: ${this.currentProfile.interval}ms, timeout: ${this.currentProfile.timeout}ms`);
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
      if (this.latencyHistory.length > 50) {
        this.latencyHistory.shift(); // Keep only recent history
      }

      log.log(`🏥 ConnectionHealthMonitor: Ping successful - ${latency}ms (${this.status.quality})`);

    } catch (error) {
      // Handle ping failure
      this.status.consecutiveFailures += 1;

      // Track failure for auto-detection
      this.failureHistory.push({
        timestamp: Date.now(),
        type: error instanceof Error ? error.message : 'unknown'
      });

      // Keep only recent failure history (last hour)
      const oneHourAgo = Date.now() - (60 * 60 * 1000);
      this.failureHistory = this.failureHistory.filter(f => f.timestamp > oneHourAgo);

      log.error(`🏥 ConnectionHealthMonitor: Ping failed (${this.status.consecutiveFailures}/${this.currentProfile.maxConsecutiveFailures}): ${error instanceof Error ? error.message : String(error)}`);

      // Update quality based on failure count (using current profile max failures)
      if (this.status.consecutiveFailures >= this.currentProfile.maxConsecutiveFailures) {
        this.status.quality = 'failed';
      } else {
        this.status.quality = 'poor';
      }
    }

    // Update uptime/downtime
    this.updateTimingMetrics();

    // Periodically check if we should auto-switch profiles (every 10 checks)
    if (this.latencyHistory.length % 10 === 0 && this.latencyHistory.length > 0) {
      this.applyAutoDetectedProfile();
    }

    // Notify listeners
    this.notifyListeners();
  }

  /**
   * Ping the server using a lightweight method
   */
  private async pingServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Ping timeout'));
      }, this.currentProfile.timeout);

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

      log.log(`🏥 ConnectionHealthMonitor: State machine updated: ${state} (${event.type})`);
      this.notifyListeners();
    });

    // Listen to socket events and forward to state machine
    apiSocket.onStatusChange((socketStatus) => {
      const now = Date.now();
      let event: StateTransitionEvent;

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
          this.networkChangeCount++;
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
      log.log('🏥 ConnectionHealthMonitor: Reconnection detected');
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
        log.error(`🏥 ConnectionHealthMonitor: Error in listener: ${error instanceof Error ? error.message : String(error)}`);
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