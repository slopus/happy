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
    poor: 2000               // < 2000ms
  }
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

  constructor(config: Partial<ConnectionHealthConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    this.status = {
      quality: 'unknown',
      state: ConnectionState.OFFLINE,
      latency: null,
      lastSuccessfulPing: null,
      consecutiveFailures: 0,
      uptime: 0,
      downtime: 0
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

    // Start periodic ping checks
    this.pingInterval = setInterval(() => {
      this.performHealthCheck();
    }, this.config.pingInterval);

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

      console.log(`🏥 ConnectionHealthMonitor: Ping successful - ${latency}ms (${this.status.quality})`);

    } catch (error) {
      // Handle ping failure
      this.status.consecutiveFailures += 1;

      console.warn(`🏥 ConnectionHealthMonitor: Ping failed (${this.status.consecutiveFailures}/${this.config.maxConsecutiveFailures})`, error);

      // Update quality based on failure count
      if (this.status.consecutiveFailures >= this.config.maxConsecutiveFailures) {
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
      const timeout = setTimeout(() => {
        reject(new Error('Ping timeout'));
      }, this.config.pingTimeout);

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

      console.log(`🏥 ConnectionHealthMonitor: State machine updated: ${state} (${event.type})`);
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
        timestamp: Date.now()
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