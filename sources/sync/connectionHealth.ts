/**
 * Enhanced connection health monitoring system
 * Provides real-time connection quality assessment and proactive monitoring
 */

import { apiSocket } from './apiSocket';
import { storage } from './storage';
import { connectionStateMachine, ConnectionState, type StateTransitionEvent } from './connectionStateMachine';

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
    interval: 30000,      // 30 seconds
    timeout: 10000,       // 10 seconds
    maxConsecutiveFailures: 3,
  } as HeartbeatProfile,
  aggressive: {
    interval: 15000,      // 15 seconds - faster detection
    timeout: 5000,        // 5 seconds
    maxConsecutiveFailures: 2,
  } as HeartbeatProfile,
  corporate: {
    interval: 10000,      // 10 seconds - most aggressive
    timeout: 3000,        // 3 seconds
    maxConsecutiveFailures: 1,
  } as HeartbeatProfile,
  battery_saver: {
    interval: 60000,      // 60 seconds - reduced frequency
    timeout: 15000,       // 15 seconds
    maxConsecutiveFailures: 5,
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
  private pingInterval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private listeners = new Set<(status: ConnectionHealthStatus) => void>();

  // Timing tracking
  private connectionStartTime: number | null = null;
  private lastDisconnectTime: number | null = null;
  private totalDowntime = 0;

  // Profile management
  private currentProfile: keyof typeof HEARTBEAT_PROFILES = 'standard';

  // Auto-detection data
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

    this.setupSocketListeners();
  }

  /**
   * Start connection health monitoring
   */
  start(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    console.log('🏥 ConnectionHealthMonitor: Starting health monitoring');

    // Start periodic ping checks using current profile interval
    const currentProfileData = HEARTBEAT_PROFILES[this.currentProfile];
    this.pingInterval = setInterval(() => {
      this.performHealthCheck();
    }, currentProfileData.interval);

    // Perform initial health check
    this.performHealthCheck();
  }

  /**
   * Stop connection health monitoring
   */
  stop(): void {
    if (!this.isRunning) return;

    this.isRunning = false;
    console.log('🏥 ConnectionHealthMonitor: Stopping health monitoring');

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
      console.warn(`Unknown profile '${profileName}', falling back to 'standard'`);
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
      if (this.latencyHistory.length > 50) {
        this.latencyHistory = this.latencyHistory.slice(-50);
      }

      // Trigger auto-detection periodically
      if (this.latencyHistory.length % 10 === 0 && this.latencyHistory.length > 0) {
        this.applyAutoDetectedProfile();
      }

      console.log(`🏥 ConnectionHealthMonitor: Ping successful - ${latency}ms (${this.status.quality})`);

    } catch (error) {
      // Handle ping failure
      this.status.consecutiveFailures += 1;

      // Track failure for auto-detection
      this.failureHistory.push({
        timestamp: Date.now(),
        type: error instanceof Error ? error.message : 'unknown',
      });

      // Clean old failures (older than 1 hour)
      const oneHourAgo = Date.now() - (60 * 60 * 1000);
      this.failureHistory = this.failureHistory.filter(f => f.timestamp > oneHourAgo);

      console.warn(`🏥 ConnectionHealthMonitor: Ping failed (${this.status.consecutiveFailures}/${currentProfileData.maxConsecutiveFailures})`, error);

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

      console.log(`🏥 ConnectionHealthMonitor: State machine updated: ${state} (${event.type})`);
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
      console.log('🏥 ConnectionHealthMonitor: Reconnection detected');
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
        console.error('🏥 ConnectionHealthMonitor: Error in listener:', error);
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