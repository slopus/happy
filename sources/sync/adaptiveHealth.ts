/**
 * Adaptive Health Monitoring System
 * Implements Task 2.2 from ConnectionV2Todo.md
 *
 * Provides adaptive ping interval adjustment based on network stability,
 * consecutive success/failure tracking, latency trend analysis,
 * and configurable min/max intervals with smooth transitions.
 */

import { log } from '@/log';

export interface AdaptiveHealthConfig {
  basePingInterval: number;
  minPingInterval: number;
  maxPingInterval: number;
  adaptationRate: number;
  stabilityThreshold: number;
}

export interface PingResult {
  timestamp: number;
  success: boolean;
  latency?: number;
  error?: string;
}

const DEFAULT_CONFIG: AdaptiveHealthConfig = {
  basePingInterval: 30000,   // 30 seconds base interval
  minPingInterval: 5000,     // 5 seconds minimum
  maxPingInterval: 120000,   // 2 minutes maximum
  adaptationRate: 0.1,       // How quickly to adapt (0.1 = 10% change per adaptation)
  stabilityThreshold: 0.8    // Stability threshold for reducing frequency
};

export class AdaptiveHealthMonitor {
  private currentInterval: number;
  private consecutiveSuccesses: number = 0;
  private consecutiveFailures: number = 0;
  private pingHistory: PingResult[] = [];
  private adaptationTimer: ReturnType<typeof setTimeout> | null = null;
  private nextPingTimer: ReturnType<typeof setTimeout> | null = null;
  private isRunning: boolean = false;
  private lastAdaptation: number = Date.now();

  // Callback for scheduling next ping
  private scheduleCallback: ((interval: number) => void) | null = null;

  constructor(private config: AdaptiveHealthConfig = DEFAULT_CONFIG) {
    this.currentInterval = config.basePingInterval;
  }

  /**
   * Start the adaptive monitoring system
   */
  start(scheduleCallback: (interval: number) => void): void {
    if (this.isRunning) {
      log.log('🔄 AdaptiveHealthMonitor: Already running, ignoring start call');
      return;
    }

    this.isRunning = true;
    this.scheduleCallback = scheduleCallback;
    log.log('🔄 AdaptiveHealthMonitor: Starting adaptive monitoring');
    // Call the callback immediately with current interval
    this.scheduleCallback(this.currentInterval);
    this.scheduleNextPing();
  }

  /**
   * Stop the adaptive monitoring system
   */
  stop(): void {
    this.isRunning = false;
    this.scheduleCallback = null;

    if (this.adaptationTimer) {
      clearTimeout(this.adaptationTimer);
      this.adaptationTimer = null;
    }

    if (this.nextPingTimer) {
      clearTimeout(this.nextPingTimer);
      this.nextPingTimer = null;
    }

    log.log('🔄 AdaptiveHealthMonitor: Stopped adaptive monitoring');
  }

  /**
   * Record a ping result and trigger adaptation logic
   */
  recordPingResult(result: PingResult): void {
    if (!this.isRunning) return;

    this.pingHistory.push(result);

    // Keep only recent history (last 20 results)
    if (this.pingHistory.length > 20) {
      this.pingHistory.shift();
    }

    if (result.success) {
      this.consecutiveSuccesses++;
      this.consecutiveFailures = 0;
      log.log(`🔄 AdaptiveHealthMonitor: Ping success (${this.consecutiveSuccesses} consecutive), latency: ${result.latency}ms`);
    } else {
      this.consecutiveFailures++;
      this.consecutiveSuccesses = 0;
      log.error(`🔄 AdaptiveHealthMonitor: Ping failure (${this.consecutiveFailures} consecutive), error: ${result.error}`);
    }

    this.scheduleAdaptation();
  }

  /**
   * Get current ping interval
   */
  getCurrentInterval(): number {
    return this.currentInterval;
  }

  /**
   * Get current monitoring status
   */
  getStatus(): {
    currentInterval: number;
    consecutiveSuccesses: number;
    consecutiveFailures: number;
    stability: number;
    latencyTrend: number;
    totalPings: number;
    successRate: number;
  } {
    return {
      currentInterval: this.currentInterval,
      consecutiveSuccesses: this.consecutiveSuccesses,
      consecutiveFailures: this.consecutiveFailures,
      stability: this.calculateStability(),
      latencyTrend: this.calculateLatencyTrend(),
      totalPings: this.pingHistory.length,
      successRate: this.pingHistory.length > 0
        ? this.pingHistory.filter(r => r.success).length / this.pingHistory.length
        : 0
    };
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<AdaptiveHealthConfig>): void {
    this.config = { ...this.config, ...newConfig };

    // Ensure current interval is within new bounds
    this.currentInterval = Math.max(
      this.config.minPingInterval,
      Math.min(this.config.maxPingInterval, this.currentInterval)
    );

    log.log(`🔄 AdaptiveHealthMonitor: Configuration updated: ${JSON.stringify(this.config)}`);
  }

  /**
   * Schedule adaptation after a delay to avoid oscillation
   */
  private scheduleAdaptation(): void {
    if (this.adaptationTimer) {
      clearTimeout(this.adaptationTimer);
    }

    // Minimum time between adaptations to prevent oscillation
    const timeSinceLastAdaptation = Date.now() - this.lastAdaptation;
    const minAdaptationInterval = 5000; // 5 seconds

    const delay = Math.max(0, minAdaptationInterval - timeSinceLastAdaptation);

    this.adaptationTimer = setTimeout(() => {
      this.adaptPingInterval();
      this.lastAdaptation = Date.now();
    }, delay);
  }

  /**
   * Core adaptation logic - adjusts ping interval based on network conditions
   */
  private adaptPingInterval(): void {
    if (!this.isRunning) return;

    const stability = this.calculateStability();
    const latencyTrend = this.calculateLatencyTrend();
    const oldInterval = this.currentInterval;

    log.log(`🔄 AdaptiveHealthMonitor: Adapting interval - stability: ${stability.toFixed(2)}, latency trend: ${latencyTrend.toFixed(2)}`);

    // Decision matrix for interval adjustment
    if (this.consecutiveFailures >= 2 || stability < 0.7) {
      // Network is unstable - increase frequency (decrease interval)
      this.currentInterval = Math.max(
        this.config.minPingInterval,
        this.currentInterval * 0.7
      );
      log.log(`🔄 AdaptiveHealthMonitor: Network unstable - increasing frequency to ${this.currentInterval}ms`);

    } else if (this.consecutiveSuccesses >= 5 && stability > this.config.stabilityThreshold) {
      // Network is very stable - can reduce frequency (increase interval)
      this.currentInterval = Math.min(
        this.config.maxPingInterval,
        this.currentInterval * 1.3
      );
      log.log(`🔄 AdaptiveHealthMonitor: Network stable - reducing frequency to ${this.currentInterval}ms`);

    } else if (latencyTrend > 1.5) {
      // Latency is increasing - check more frequently
      this.currentInterval = Math.max(
        this.config.minPingInterval,
        this.currentInterval * 0.8
      );
      log.log(`🔄 AdaptiveHealthMonitor: Latency trending up - increasing frequency to ${this.currentInterval}ms`);

    } else if (latencyTrend < 0.7 && stability > 0.85) {
      // Latency improving and stable - can reduce frequency slightly
      this.currentInterval = Math.min(
        this.config.maxPingInterval,
        this.currentInterval * 1.1
      );
      log.log(`🔄 AdaptiveHealthMonitor: Latency improving - reducing frequency to ${this.currentInterval}ms`);
    }

    // Ensure interval is within bounds
    this.currentInterval = Math.max(
      this.config.minPingInterval,
      Math.min(this.config.maxPingInterval, this.currentInterval)
    );

    // Only reschedule if interval changed significantly (>10% change)
    const changePercent = Math.abs(this.currentInterval - oldInterval) / oldInterval;
    if (changePercent > 0.1) {
      log.log(`🔄 AdaptiveHealthMonitor: Interval changed from ${oldInterval}ms to ${this.currentInterval}ms (${(changePercent * 100).toFixed(1)}% change)`);
      if (this.scheduleCallback) {
        this.scheduleCallback(this.currentInterval);
      }
      this.scheduleNextPing();
    }
  }

  /**
   * Calculate network stability based on success rate and latency variance
   */
  private calculateStability(): number {
    if (this.pingHistory.length < 5) return 1.0;

    const recentResults = this.pingHistory.slice(-10);
    const successRate = recentResults.filter(r => r.success).length / recentResults.length;

    // Factor in latency variance for successful pings
    const latencies = recentResults
      .filter(r => r.success && r.latency !== undefined)
      .map(r => r.latency!);

    if (latencies.length < 3) return successRate;

    const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const variance = latencies.reduce((acc, lat) =>
      acc + Math.pow(lat - avgLatency, 2), 0) / latencies.length;

    // Calculate latency stability (lower variance = higher stability)
    const latencyStability = avgLatency > 0
      ? Math.max(0, 1 - (Math.sqrt(variance) / avgLatency))
      : 1.0;

    // Weighted combination: success rate (70%) + latency stability (30%)
    return (successRate * 0.7) + (latencyStability * 0.3);
  }

  /**
   * Calculate latency trend to detect improving/degrading conditions
   */
  private calculateLatencyTrend(): number {
    if (this.pingHistory.length < 6) return 1.0;

    const recentLatencies = this.pingHistory
      .slice(-6)
      .filter(r => r.success && r.latency !== undefined)
      .map(r => r.latency!);

    if (recentLatencies.length < 4) return 1.0;

    // Compare first half vs second half of recent measurements
    const midpoint = Math.floor(recentLatencies.length / 2);
    const firstHalf = recentLatencies.slice(0, midpoint);
    const secondHalf = recentLatencies.slice(midpoint);

    const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
    const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

    // Return ratio: >1 means latency increasing, <1 means improving
    return avgFirst > 0 ? avgSecond / avgFirst : 1.0;
  }

  /**
   * Schedule the next ping with current interval
   */
  private scheduleNextPing(): void {
    if (!this.isRunning) return;

    if (this.nextPingTimer) {
      clearTimeout(this.nextPingTimer);
      this.nextPingTimer = null;
    }

    // This is mainly for internal scheduling - the external callback handles actual pings
  }

  /**
   * Force immediate adaptation (for testing or manual triggering)
   */
  forceAdaptation(): void {
    if (this.adaptationTimer) {
      clearTimeout(this.adaptationTimer);
    }
    this.adaptPingInterval();
    this.lastAdaptation = Date.now();
  }

  /**
   * Reset monitoring state (useful for network changes)
   */
  reset(): void {
    this.consecutiveSuccesses = 0;
    this.consecutiveFailures = 0;
    this.pingHistory = [];
    this.currentInterval = this.config.basePingInterval;
    this.lastAdaptation = Date.now();

    if (this.adaptationTimer) {
      clearTimeout(this.adaptationTimer);
      this.adaptationTimer = null;
    }

    log.log('🔄 AdaptiveHealthMonitor: State reset');
  }

  /**
   * Get detailed analytics for debugging and monitoring
   */
  getAnalytics(): {
    config: AdaptiveHealthConfig;
    currentState: {
      interval: number;
      consecutiveSuccesses: number;
      consecutiveFailures: number;
      isRunning: boolean;
    };
    recentHistory: PingResult[];
    metrics: {
      stability: number;
      latencyTrend: number;
      successRate: number;
      avgLatency: number;
      adaptationsSinceStart: number;
    };
  } {
    const successfulPings = this.pingHistory.filter(r => r.success && r.latency !== undefined);
    const avgLatency = successfulPings.length > 0
      ? successfulPings.reduce((sum, r) => sum + r.latency!, 0) / successfulPings.length
      : 0;

    return {
      config: { ...this.config },
      currentState: {
        interval: this.currentInterval,
        consecutiveSuccesses: this.consecutiveSuccesses,
        consecutiveFailures: this.consecutiveFailures,
        isRunning: this.isRunning,
      },
      recentHistory: [...this.pingHistory],
      metrics: {
        stability: this.calculateStability(),
        latencyTrend: this.calculateLatencyTrend(),
        successRate: this.pingHistory.length > 0
          ? this.pingHistory.filter(r => r.success).length / this.pingHistory.length
          : 0,
        avgLatency,
        adaptationsSinceStart: 0, // Could track this if needed
      }
    };
  }
}

// Global singleton instance for use across the app
export const adaptiveHealthMonitor = new AdaptiveHealthMonitor();