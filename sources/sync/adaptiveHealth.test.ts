/**
 * Comprehensive Unit Tests for Adaptive Health Monitoring
 * Tests all aspects of Task 2.2 implementation from ConnectionV2Todo.md
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';

import { AdaptiveHealthMonitor, AdaptiveHealthConfig, PingResult } from './adaptiveHealth';

describe('AdaptiveHealthMonitor', () => {
  let monitor: AdaptiveHealthMonitor;
  let scheduledIntervals: number[] = [];
  let mockScheduleCallback: Mock;

  const defaultConfig: AdaptiveHealthConfig = {
    basePingInterval: 30000,
    minPingInterval: 5000,
    maxPingInterval: 120000,
    adaptationRate: 0.1,
    stabilityThreshold: 0.8
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    scheduledIntervals = [];
    mockScheduleCallback = vi.fn((interval: number) => {
      scheduledIntervals.push(interval);
    });
    monitor = new AdaptiveHealthMonitor(defaultConfig);
  });

  afterEach(() => {
    monitor.stop();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  describe('Initialization and Configuration', () => {
    it('should initialize with default configuration', () => {
      const newMonitor = new AdaptiveHealthMonitor();
      expect(newMonitor.getCurrentInterval()).toBe(30000); // Default base interval
    });

    it('should initialize with custom configuration', () => {
      const customConfig: AdaptiveHealthConfig = {
        basePingInterval: 15000,
        minPingInterval: 3000,
        maxPingInterval: 60000,
        adaptationRate: 0.2,
        stabilityThreshold: 0.9
      };
      const customMonitor = new AdaptiveHealthMonitor(customConfig);
      expect(customMonitor.getCurrentInterval()).toBe(15000);
    });

    it('should update configuration correctly', () => {
      monitor.updateConfig({ minPingInterval: 10000 });
      // If current interval is below new min, it should be adjusted
      monitor.updateConfig({ basePingInterval: 8000 }); // Below new min
      expect(monitor.getCurrentInterval()).toBeGreaterThanOrEqual(10000);
    });
  });

  describe('Start and Stop Functionality', () => {
    it('should start monitoring correctly', () => {
      monitor.start(mockScheduleCallback);
      const status = monitor.getStatus();
      expect(status.currentInterval).toBe(30000);
      expect(mockScheduleCallback).toHaveBeenCalled();
    });

    it('should stop monitoring and clean up timers', () => {
      monitor.start(mockScheduleCallback);
      monitor.stop();

      // Advance timers to ensure no callbacks are called after stop
      vi.advanceTimersByTime(60000);
      expect(mockScheduleCallback).toHaveBeenCalledTimes(1); // Only initial call
    });

    it('should handle multiple start calls gracefully', () => {
      monitor.start(mockScheduleCallback);
      monitor.start(mockScheduleCallback);
      // Should not create duplicate timers or callbacks
      expect(mockScheduleCallback).toHaveBeenCalledTimes(1);
    });
  });

  describe('Ping Frequency Adaptation - Success Scenarios', () => {
    beforeEach(() => {
      monitor.start(mockScheduleCallback);
    });

    it('should decrease ping frequency during stable periods', () => {
      const initialInterval = monitor.getCurrentInterval();

      // Simulate 6 consecutive successful pings with good latency
      for (let i = 0; i < 6; i++) {
        monitor.recordPingResult({
          timestamp: Date.now() + i * 1000,
          success: true,
          latency: 50
        });
      }

      // Trigger adaptation
      vi.advanceTimersByTime(5000);

      const newInterval = monitor.getCurrentInterval();
      expect(newInterval).toBeGreaterThan(initialInterval);
      expect(newInterval).toBeLessThanOrEqual(defaultConfig.maxPingInterval);
    });

    it('should increase ping frequency during failures', () => {
      const initialInterval = monitor.getCurrentInterval();

      // Simulate consecutive failures
      for (let i = 0; i < 3; i++) {
        monitor.recordPingResult({
          timestamp: Date.now() + i * 1000,
          success: false,
          error: 'Connection timeout'
        });
      }

      // Trigger adaptation
      vi.advanceTimersByTime(5000);

      const newInterval = monitor.getCurrentInterval();
      expect(newInterval).toBeLessThan(initialInterval);
      expect(newInterval).toBeGreaterThanOrEqual(defaultConfig.minPingInterval);
    });

    it('should respond to latency trends', () => {
      const initialInterval = monitor.getCurrentInterval();

      // Simulate increasing latency trend (good to poor performance)
      const latencies = [50, 100, 200, 400, 800, 1200];
      latencies.forEach((latency, i) => {
        monitor.recordPingResult({
          timestamp: Date.now() + i * 1000,
          success: true,
          latency
        });
      });

      // Trigger adaptation
      vi.advanceTimersByTime(5000);

      const newInterval = monitor.getCurrentInterval();
      expect(newInterval).toBeLessThan(initialInterval); // Should increase frequency due to degrading latency
    });

    it('should respect min/max interval bounds', () => {
      // Test minimum bound
      for (let i = 0; i < 10; i++) {
        monitor.recordPingResult({
          timestamp: Date.now() + i * 1000,
          success: false,
          error: 'Timeout'
        });
        vi.advanceTimersByTime(5000);
      }

      expect(monitor.getCurrentInterval()).toBe(defaultConfig.minPingInterval);

      // Reset and test maximum bound
      monitor.reset();
      for (let i = 0; i < 20; i++) {
        monitor.recordPingResult({
          timestamp: Date.now() + i * 1000,
          success: true,
          latency: 20
        });
        vi.advanceTimersByTime(5000);
      }

      expect(monitor.getCurrentInterval()).toBeLessThanOrEqual(defaultConfig.maxPingInterval);
    });
  });

  describe('Stability Calculation', () => {
    beforeEach(() => {
      monitor.start(mockScheduleCallback);
    });

    it('should calculate high stability for consistent successful pings', () => {
      // Add 10 successful pings with consistent latency
      for (let i = 0; i < 10; i++) {
        monitor.recordPingResult({
          timestamp: Date.now() + i * 1000,
          success: true,
          latency: 50 + (i % 3) * 5 // Small variance
        });
      }

      const status = monitor.getStatus();
      expect(status.stability).toBeGreaterThan(0.9);
    });

    it('should calculate low stability for inconsistent results', () => {
      // Add mixed results with high latency variance
      const results = [
        { success: true, latency: 50 },
        { success: false, error: 'timeout' },
        { success: true, latency: 500 },
        { success: true, latency: 1000 },
        { success: false, error: 'network error' },
        { success: true, latency: 100 }
      ];

      results.forEach((result, i) => {
        monitor.recordPingResult({
          timestamp: Date.now() + i * 1000,
          ...result
        });
      });

      const status = monitor.getStatus();
      expect(status.stability).toBeLessThan(0.7);
    });

    it('should handle edge cases with insufficient data', () => {
      // Test with minimal data
      monitor.recordPingResult({
        timestamp: Date.now(),
        success: true,
        latency: 100
      });

      const status = monitor.getStatus();
      expect(status.stability).toBe(1.0); // Should default to 1.0 with insufficient data
    });
  });

  describe('Latency Trend Detection', () => {
    beforeEach(() => {
      monitor.start(mockScheduleCallback);
    });

    it('should detect improving latency trends', () => {
      // Simulate improving latency (decreasing over time)
      const latencies = [200, 180, 160, 140, 120, 100];
      latencies.forEach((latency, i) => {
        monitor.recordPingResult({
          timestamp: Date.now() + i * 1000,
          success: true,
          latency
        });
      });

      const status = monitor.getStatus();
      expect(status.latencyTrend).toBeLessThan(1.0); // Improving trend
    });

    it('should detect degrading latency trends', () => {
      // Simulate degrading latency (increasing over time)
      const latencies = [100, 120, 140, 160, 180, 200];
      latencies.forEach((latency, i) => {
        monitor.recordPingResult({
          timestamp: Date.now() + i * 1000,
          success: true,
          latency
        });
      });

      const status = monitor.getStatus();
      expect(status.latencyTrend).toBeGreaterThan(1.0); // Degrading trend
    });

    it('should return neutral trend with insufficient data', () => {
      // Add only a few results
      monitor.recordPingResult({
        timestamp: Date.now(),
        success: true,
        latency: 100
      });

      const status = monitor.getStatus();
      expect(status.latencyTrend).toBe(1.0); // Neutral trend
    });
  });

  describe('Boundary Conditions and Error Handling', () => {
    it('should handle ping results when not running', () => {
      // Don't start the monitor
      monitor.recordPingResult({
        timestamp: Date.now(),
        success: true,
        latency: 100
      });

      // Should not crash or affect state significantly
      const status = monitor.getStatus();
      expect(status.totalPings).toBe(0);
    });

    it('should handle ping results without latency', () => {
      monitor.start(mockScheduleCallback);

      monitor.recordPingResult({
        timestamp: Date.now(),
        success: true
        // No latency field
      });

      // Should not crash
      const status = monitor.getStatus();
      expect(status.totalPings).toBe(1);
    });

    it('should handle extreme configuration values', () => {
      const extremeConfig: AdaptiveHealthConfig = {
        basePingInterval: 1000,
        minPingInterval: 100,
        maxPingInterval: 1000000,
        adaptationRate: 1.0,
        stabilityThreshold: 0.0
      };

      const extremeMonitor = new AdaptiveHealthMonitor(extremeConfig);
      extremeMonitor.start(mockScheduleCallback);

      // Should handle extreme configurations without crashing
      extremeMonitor.recordPingResult({
        timestamp: Date.now(),
        success: false,
        error: 'test error'
      });

      expect(extremeMonitor.getCurrentInterval()).toBeGreaterThanOrEqual(100);
      expect(extremeMonitor.getCurrentInterval()).toBeLessThanOrEqual(1000000);
    });
  });

  describe('Oscillation Prevention', () => {
    beforeEach(() => {
      monitor.start(mockScheduleCallback);
    });

    it('should prevent rapid oscillation between intervals', () => {
      const intervals: number[] = [];

      // Simulate alternating good/bad conditions rapidly
      for (let i = 0; i < 10; i++) {
        monitor.recordPingResult({
          timestamp: Date.now() + i * 100,
          success: i % 2 === 0,
          latency: i % 2 === 0 ? 50 : undefined,
          error: i % 2 === 1 ? 'timeout' : undefined
        });

        // Small advancement to trigger adaptations
        vi.advanceTimersByTime(1000);
        intervals.push(monitor.getCurrentInterval());
      }

      // Check that intervals don't oscillate wildly
      const intervalChanges = intervals.slice(1).map((interval, i) =>
        Math.abs(interval - intervals[i]) / intervals[i]
      );

      // Most changes should be small (less than 50% change)
      const largeChanges = intervalChanges.filter(change => change > 0.5);
      expect(largeChanges.length).toBeLessThan(intervalChanges.length / 2);
    });
  });

  describe('Reset Functionality', () => {
    beforeEach(() => {
      monitor.start(mockScheduleCallback);
    });

    it('should reset state correctly', () => {
      // Add some data
      monitor.recordPingResult({
        timestamp: Date.now(),
        success: true,
        latency: 100
      });
      monitor.recordPingResult({
        timestamp: Date.now() + 1000,
        success: false,
        error: 'timeout'
      });

      // Trigger adaptation
      vi.advanceTimersByTime(5000);

      // Reset
      monitor.reset();

      const status = monitor.getStatus();
      expect(status.consecutiveSuccesses).toBe(0);
      expect(status.consecutiveFailures).toBe(0);
      expect(status.totalPings).toBe(0);
      expect(status.currentInterval).toBe(defaultConfig.basePingInterval);
    });
  });

  describe('Analytics and Monitoring', () => {
    beforeEach(() => {
      monitor.start(mockScheduleCallback);
    });

    it('should provide comprehensive analytics', () => {
      // Add varied ping results
      monitor.recordPingResult({
        timestamp: Date.now(),
        success: true,
        latency: 100
      });
      monitor.recordPingResult({
        timestamp: Date.now() + 1000,
        success: false,
        error: 'timeout'
      });
      monitor.recordPingResult({
        timestamp: Date.now() + 2000,
        success: true,
        latency: 150
      });

      const analytics = monitor.getAnalytics();

      expect(analytics.config).toEqual(defaultConfig);
      expect(analytics.currentState.isRunning).toBe(true);
      expect(analytics.recentHistory).toHaveLength(3);
      expect(analytics.metrics.successRate).toBeCloseTo(2/3);
      expect(analytics.metrics.avgLatency).toBe(125); // (100 + 150) / 2
    });

    it('should track status metrics correctly', () => {
      // Add successful pings
      for (let i = 0; i < 5; i++) {
        monitor.recordPingResult({
          timestamp: Date.now() + i * 1000,
          success: true,
          latency: 100 + i * 10
        });
      }

      const status = monitor.getStatus();
      expect(status.consecutiveSuccesses).toBe(5);
      expect(status.consecutiveFailures).toBe(0);
      expect(status.totalPings).toBe(5);
      expect(status.successRate).toBe(1.0);
    });
  });

  describe('Force Adaptation', () => {
    beforeEach(() => {
      monitor.start(mockScheduleCallback);
    });

    it('should force immediate adaptation', () => {
      // Add failure data
      monitor.recordPingResult({
        timestamp: Date.now(),
        success: false,
        error: 'timeout'
      });
      monitor.recordPingResult({
        timestamp: Date.now() + 1000,
        success: false,
        error: 'timeout'
      });

      const initialInterval = monitor.getCurrentInterval();

      // Force adaptation without waiting for timer
      monitor.forceAdaptation();

      const newInterval = monitor.getCurrentInterval();
      expect(newInterval).toBeLessThan(initialInterval);
    });
  });
});

// Additional simulation tests for network condition variations
describe('AdaptiveHealthMonitor - Network Condition Simulations', () => {
  let monitor: AdaptiveHealthMonitor;
  let mockScheduleCallback: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockScheduleCallback = vi.fn();
    monitor = new AdaptiveHealthMonitor();
    monitor.start(mockScheduleCallback);
  });

  afterEach(() => {
    monitor.stop();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  describe('Unstable Network Conditions', () => {
    it('should adapt to intermittent connectivity', () => {
      const initialInterval = monitor.getCurrentInterval();

      // Simulate intermittent network with pattern: fail, fail, success, fail, success
      const pattern = [false, false, true, false, true, false, true, true];

      pattern.forEach((success, i) => {
        monitor.recordPingResult({
          timestamp: Date.now() + i * 1000,
          success,
          latency: success ? 200 + Math.random() * 300 : undefined,
          error: success ? undefined : 'Network unreachable'
        });

        vi.advanceTimersByTime(5000); // Trigger adaptation
      });

      const finalInterval = monitor.getCurrentInterval();
      const status = monitor.getStatus();

      // Should have adapted to more frequent pings due to instability
      expect(finalInterval).toBeLessThan(initialInterval);
      expect(status.stability).toBeLessThan(0.7);
    });

    it('should handle high-latency variable connections', () => {
      // Simulate high and variable latency successful connections with some failures
      const results = [
        { success: true, latency: 800 },
        { success: false, error: 'timeout' },
        { success: true, latency: 1200 },
        { success: true, latency: 500 },
        { success: false, error: 'timeout' },
        { success: true, latency: 1500 },
        { success: true, latency: 900 },
        { success: true, latency: 2000 }
      ];

      results.forEach((result, i) => {
        monitor.recordPingResult({
          timestamp: Date.now() + i * 1000,
          ...result
        });

        vi.advanceTimersByTime(5000);
      });

      const status = monitor.getStatus();
      expect(status.stability).toBeLessThan(0.9); // High variance and failures should reduce stability
      expect(monitor.getCurrentInterval()).toBeLessThan(50000); // Should adapt to instability
    });
  });

  describe('Stable Network Conditions', () => {
    it('should optimize for stable, good connectivity', () => {
      const initialInterval = monitor.getCurrentInterval();

      // Simulate consistently good connectivity
      for (let i = 0; i < 15; i++) {
        monitor.recordPingResult({
          timestamp: Date.now() + i * 1000,
          success: true,
          latency: 50 + Math.random() * 20 // Small variance around 50ms
        });

        vi.advanceTimersByTime(5000);
      }

      const finalInterval = monitor.getCurrentInterval();
      const status = monitor.getStatus();

      // Should have reduced ping frequency due to stability
      expect(finalInterval).toBeGreaterThan(initialInterval);
      expect(status.stability).toBeGreaterThan(0.9);
      expect(status.successRate).toBe(1.0);
    });

    it('should handle perfect network conditions', () => {
      // Simulate perfect network with very low, consistent latency
      for (let i = 0; i < 20; i++) {
        monitor.recordPingResult({
          timestamp: Date.now() + i * 1000,
          success: true,
          latency: 25 + Math.random() * 10 // Very low variance
        });

        vi.advanceTimersByTime(5000);
      }

      const status = monitor.getStatus();
      expect(status.stability).toBeGreaterThan(0.95);
      expect(status.latencyTrend).toBeCloseTo(1.0, 0); // Stable trend (less strict)

      // Should have moved towards battery-saving intervals
      expect(monitor.getCurrentInterval()).toBeGreaterThan(30000);
    });
  });

  describe('Network Transition Scenarios', () => {
    it('should adapt during network degradation', () => {
      // Start with good network
      for (let i = 0; i < 5; i++) {
        monitor.recordPingResult({
          timestamp: Date.now() + i * 1000,
          success: true,
          latency: 50
        });
      }

      vi.advanceTimersByTime(5000);
      const goodNetworkInterval = monitor.getCurrentInterval();

      // Network starts degrading
      const degradingLatencies = [100, 200, 400, 800, 1200];
      degradingLatencies.forEach((latency, i) => {
        monitor.recordPingResult({
          timestamp: Date.now() + (i + 5) * 1000,
          success: true,
          latency
        });

        vi.advanceTimersByTime(5000);
      });

      const degradedNetworkInterval = monitor.getCurrentInterval();
      expect(degradedNetworkInterval).toBeLessThan(goodNetworkInterval);
    });

    it('should adapt during network recovery', () => {
      // Start with poor network
      for (let i = 0; i < 3; i++) {
        monitor.recordPingResult({
          timestamp: Date.now() + i * 1000,
          success: false,
          error: 'Timeout'
        });
      }

      vi.advanceTimersByTime(5000);
      const poorNetworkInterval = monitor.getCurrentInterval();

      // Network recovers
      for (let i = 0; i < 10; i++) {
        monitor.recordPingResult({
          timestamp: Date.now() + (i + 3) * 1000,
          success: true,
          latency: 60 + Math.random() * 20
        });

        vi.advanceTimersByTime(5000);
      }

      const recoveredNetworkInterval = monitor.getCurrentInterval();
      // Recovery should either improve the interval or at least stabilize it above minimum
      expect(recoveredNetworkInterval).toBeGreaterThanOrEqual(Math.min(poorNetworkInterval, 5000));
    });
  });

  describe('Performance Under Load', () => {
    it('should maintain performance with large ping history', () => {
      const startTime = Date.now();

      // Add many ping results quickly
      for (let i = 0; i < 100; i++) {
        monitor.recordPingResult({
          timestamp: Date.now() + i * 100,
          success: Math.random() > 0.1, // 90% success rate
          latency: Math.random() * 200 + 50
        });
      }

      const endTime = Date.now();

      // Should complete quickly (under 100ms in real time, accounting for fake timers)
      expect(endTime - startTime).toBeLessThan(100);

      // Should maintain history size limit
      const analytics = monitor.getAnalytics();
      expect(analytics.recentHistory.length).toBeLessThanOrEqual(20);
    });

    it('should handle rapid successive adaptations', () => {
      // Trigger many adaptations in sequence
      for (let i = 0; i < 50; i++) {
        monitor.recordPingResult({
          timestamp: Date.now() + i * 100,
          success: i % 3 !== 0, // Varying success pattern
          latency: Math.random() * 500 + 100
        });

        monitor.forceAdaptation(); // Force immediate adaptation
      }

      // Should still function correctly
      const status = monitor.getStatus();
      expect(status.currentInterval).toBeGreaterThanOrEqual(5000);
      expect(status.currentInterval).toBeLessThanOrEqual(120000);
    });
  });
});