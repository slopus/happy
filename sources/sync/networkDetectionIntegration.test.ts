/**
 * Integration tests for NetworkDetection with connection management
 */

import { describe, it, expect, beforeEach, afterEach, vi, type MockedFunction } from 'vitest';

// Mock NetInfo types for testing
interface NetInfoState {
  type: string;
  isConnected: boolean | null;
  isInternetReachable: boolean | null;
  details: any;
}

const mockNetInfo = {
  fetch: vi.fn(),
  addEventListener: vi.fn(),
};

// Set up global mock for the NetworkDetection module
(global as any).mockNetInfo = mockNetInfo;

// Mock NetInfo
vi.mock('@react-native-community/netinfo', () => ({
  default: mockNetInfo
}));

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Import after mocking
import {
  NetworkDetection,
  NetworkProfile,
  ConnectionStrategy,
  networkDetection,
  startNetworkDetection,
  stopNetworkDetection,
  type NetworkChangeListener
} from '@/sync/networkDetection';

describe('NetworkDetection Integration', () => {
  const mockNetInfoFetch = mockNetInfo.fetch as MockedFunction<typeof mockNetInfo.fetch>;
  const mockNetInfoAddEventListener = mockNetInfo.addEventListener as MockedFunction<typeof mockNetInfo.addEventListener>;
  let mockNetworkChangeCallback: ((state: NetInfoState) => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();

    // Setup NetInfo mock to capture the callback
    mockNetInfoAddEventListener.mockImplementation((callback: (state: NetInfoState) => void) => {
      mockNetworkChangeCallback = callback;
      return vi.fn(); // Unsubscribe function
    });
  });

  afterEach(() => {
    stopNetworkDetection();
    mockNetworkChangeCallback = null;
  });

  describe('Network Change Detection and Strategy Adaptation', () => {
    it('should detect network changes and adapt strategies automatically', async () => {
      const strategyChanges: Array<{ profile: NetworkProfile; strategy: ConnectionStrategy }> = [];
      const listener: NetworkChangeListener = (profile, strategy) => {
        strategyChanges.push({ profile: { ...profile }, strategy: JSON.parse(JSON.stringify(strategy)) });
      };

      networkDetection.addListener(listener);
      startNetworkDetection();

      // Initial WiFi excellent network
      const wifiExcellentState: NetInfoState = {
        type: 'wifi',
        isConnected: true,
        isInternetReachable: true,
        details: {
          isConnectionExpensive: false,
          ssid: 'FastWiFi',
          strength: 95
        }
      };

      mockNetInfoFetch.mockResolvedValue(wifiExcellentState);
      mockFetch.mockImplementation(() =>
        new Promise(resolve =>
          setTimeout(() => resolve(new Response('', { status: 200 })), 50) // 50ms = excellent
        )
      );

      // Simulate network change
      if (mockNetworkChangeCallback) {
        await mockNetworkChangeCallback(wifiExcellentState);
        await new Promise(resolve => setTimeout(resolve, 2100)); // Wait for adaptation delay
      }

      // Change to cellular poor network
      const cellularPoorState: NetInfoState = {
        type: 'cellular',
        isConnected: true,
        isInternetReachable: true,
        details: {
          isConnectionExpensive: true,
          cellularGeneration: '3g',
          strength: 20
        }
      };

      mockNetInfoFetch.mockResolvedValue(cellularPoorState);
      mockFetch.mockImplementation(() =>
        new Promise(resolve =>
          setTimeout(() => resolve(new Response('', { status: 200 })), 600) // 600ms = poor
        )
      );

      // Simulate another network change
      if (mockNetworkChangeCallback) {
        await mockNetworkChangeCallback(cellularPoorState);
        await new Promise(resolve => setTimeout(resolve, 2100)); // Wait for adaptation delay
      }

      // Verify strategy changes
      expect(strategyChanges.length).toBeGreaterThanOrEqual(2);

      const wifiStrategy = strategyChanges.find(change => change.profile.type === 'wifi');
      const cellularStrategy = strategyChanges.find(change => change.profile.type === 'cellular');

      expect(wifiStrategy).toBeDefined();
      expect(cellularStrategy).toBeDefined();

      // WiFi should have shorter timeouts than cellular
      expect(wifiStrategy!.strategy.timeouts.connection)
        .toBeLessThan(cellularStrategy!.strategy.timeouts.connection);

      // Cellular poor should use aggressive heartbeat
      expect(cellularStrategy!.strategy.heartbeatProfile).toBe('aggressive');
    });

    it('should handle rapid network changes with debouncing', async () => {
      const strategyChanges: Array<{ profile: NetworkProfile; strategy: ConnectionStrategy }> = [];
      const listener: NetworkChangeListener = (profile, strategy) => {
        strategyChanges.push({ profile: { ...profile }, strategy: JSON.parse(JSON.stringify(strategy)) });
      };

      networkDetection.addListener(listener);
      startNetworkDetection();

      const wifiState: NetInfoState = {
        type: 'wifi',
        isConnected: true,
        isInternetReachable: true,
        details: { isConnectionExpensive: false }
      };

      const cellularState: NetInfoState = {
        type: 'cellular',
        isConnected: true,
        isInternetReachable: true,
        details: { isConnectionExpensive: true }
      };

      mockNetInfoFetch.mockResolvedValue(wifiState);
      mockFetch.mockResolvedValue(new Response('', { status: 200 }));

      // Rapid changes
      if (mockNetworkChangeCallback) {
        await mockNetworkChangeCallback(wifiState);
        await mockNetworkChangeCallback(cellularState);
        await mockNetworkChangeCallback(wifiState);
        await mockNetworkChangeCallback(cellularState);

        // Wait for debouncing to settle
        await new Promise(resolve => setTimeout(resolve, 2500));
      }

      // Should have fewer strategy changes due to debouncing
      expect(strategyChanges.length).toBeLessThan(4);
    });

    it('should maintain connection through network transitions', async () => {
      const connectionEvents: string[] = [];
      let currentStrategy: ConnectionStrategy | null = null;

      const listener: NetworkChangeListener = (profile, strategy) => {
        connectionEvents.push(`Network changed to ${profile.type}-${profile.quality}`);
        currentStrategy = strategy;
      };

      networkDetection.addListener(listener);
      startNetworkDetection();

      // Start with WiFi
      const wifiState: NetInfoState = {
        type: 'wifi',
        isConnected: true,
        isInternetReachable: true,
        details: { isConnectionExpensive: false }
      };

      mockNetInfoFetch.mockResolvedValue(wifiState);
      mockFetch.mockResolvedValue(new Response('', { status: 200 }));

      if (mockNetworkChangeCallback) {
        await mockNetworkChangeCallback(wifiState);
        await new Promise(resolve => setTimeout(resolve, 2100));
      }

      expect(currentStrategy).toBeDefined();
      const wifiStrategy = { ...currentStrategy! };

      // Switch to cellular
      const cellularState: NetInfoState = {
        type: 'cellular',
        isConnected: true,
        isInternetReachable: true,
        details: { isConnectionExpensive: true, cellularGeneration: '4g' }
      };

      mockNetInfoFetch.mockResolvedValue(cellularState);

      if (mockNetworkChangeCallback) {
        await mockNetworkChangeCallback(cellularState);
        await new Promise(resolve => setTimeout(resolve, 2100));
      }

      expect(currentStrategy).toBeDefined();
      const cellularStrategy = { ...currentStrategy! };

      // Strategies should be different
      expect(wifiStrategy.timeouts.connection).not.toBe(cellularStrategy.timeouts.connection);
      expect(connectionEvents).toContain('Network changed to wifi-excellent');
      expect(connectionEvents).toContain('Network changed to cellular-excellent');
    });

    it('should handle offline scenarios', async () => {
      const connectionEvents: string[] = [];
      const listener: NetworkChangeListener = (profile, strategy) => {
        connectionEvents.push(`Network: ${profile.type}, Reachable: ${profile.isInternetReachable}`);
      };

      networkDetection.addListener(listener);
      startNetworkDetection();

      // Offline state
      const offlineState: NetInfoState = {
        type: 'wifi',
        isConnected: false,
        isInternetReachable: false,
        details: null
      };

      mockNetInfoFetch.mockResolvedValue(offlineState);

      if (mockNetworkChangeCallback) {
        await mockNetworkChangeCallback(offlineState);
        await new Promise(resolve => setTimeout(resolve, 2100));
      }

      const profile = networkDetection.getCurrentProfile();
      expect(profile?.isInternetReachable).toBe(false);
      expect(profile?.quality).toBe('unknown');
    });
  });

  describe('Strategy Application Performance', () => {
    it('should apply strategies within performance bounds', async () => {
      let strategyApplicationTime = 0;
      const listener: NetworkChangeListener = () => {
        strategyApplicationTime = Date.now();
      };

      networkDetection.addListener(listener);
      startNetworkDetection();

      const networkState: NetInfoState = {
        type: 'wifi',
        isConnected: true,
        isInternetReachable: true,
        details: { isConnectionExpensive: false }
      };

      mockNetInfoFetch.mockResolvedValue(networkState);
      mockFetch.mockResolvedValue(new Response('', { status: 200 }));

      const startTime = Date.now();

      if (mockNetworkChangeCallback) {
        await mockNetworkChangeCallback(networkState);
        await new Promise(resolve => setTimeout(resolve, 2100));
      }

      const totalTime = strategyApplicationTime - startTime;

      // Strategy should be applied within 5 seconds
      expect(totalTime).toBeLessThan(5000);
    });

    it('should handle high-frequency network monitoring efficiently', async () => {
      const detector = new NetworkDetection({
        adaptationDelay: 100, // Very short delay for this test
        testTimeout: 1000
      });

      const changes: number[] = [];
      detector.addListener(() => {
        changes.push(Date.now());
      });

      detector.start();

      const networkState: NetInfoState = {
        type: 'cellular',
        isConnected: true,
        isInternetReachable: true,
        details: { isConnectionExpensive: true }
      };

      mockNetInfoFetch.mockResolvedValue(networkState);
      mockFetch.mockResolvedValue(new Response('', { status: 200 }));

      // Simulate multiple rapid detections
      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(detector.detectNetworkProfile());
      }

      await Promise.all(promises);

      detector.stop();

      // Should not create excessive overhead
      expect(changes.length).toBeLessThanOrEqual(5);
    });
  });

  describe('Error Handling and Resilience', () => {
    it('should handle NetInfo failures gracefully', async () => {
      const errors: string[] = [];
      const listener: NetworkChangeListener = (profile) => {
        if (profile.quality === 'unknown') {
          errors.push('Quality assessment failed');
        }
      };

      networkDetection.addListener(listener);
      startNetworkDetection();

      // Mock NetInfo failure
      mockNetInfoFetch.mockRejectedValue(new Error('NetInfo error'));

      if (mockNetworkChangeCallback) {
        try {
          const failedState: NetInfoState = {
            type: 'unknown',
            isConnected: false,
            isInternetReachable: null,
            details: null
          };

          await mockNetworkChangeCallback(failedState);
          await new Promise(resolve => setTimeout(resolve, 2100));
        } catch (error) {
          // Should handle errors gracefully
        }
      }

      // Should still provide a fallback strategy
      const strategy = networkDetection.getCurrentStrategy();
      expect(strategy).toBeDefined();
    });

    it('should handle latency test failures', async () => {
      const detector = new NetworkDetection();
      detector.start();

      const networkState: NetInfoState = {
        type: 'wifi',
        isConnected: true,
        isInternetReachable: true,
        details: { isConnectionExpensive: false }
      };

      mockNetInfoFetch.mockResolvedValue(networkState);
      // Mock all latency tests failing
      mockFetch.mockRejectedValue(new Error('All tests failed'));

      const profile = await detector.detectNetworkProfile();

      expect(profile.quality).toBe('unknown');
      expect(profile.type).toBe('wifi'); // Should still detect type correctly

      detector.stop();
    });

    it('should recover from temporary network issues', async () => {
      const stateChanges: string[] = [];
      const listener: NetworkChangeListener = (profile) => {
        stateChanges.push(`${profile.type}-${profile.quality}`);
      };

      networkDetection.addListener(listener);
      startNetworkDetection();

      // Good network initially
      const goodState: NetInfoState = {
        type: 'wifi',
        isConnected: true,
        isInternetReachable: true,
        details: { isConnectionExpensive: false }
      };

      mockNetInfoFetch.mockResolvedValue(goodState);
      mockFetch.mockResolvedValue(new Response('', { status: 200 }));

      if (mockNetworkChangeCallback) {
        await mockNetworkChangeCallback(goodState);
        await new Promise(resolve => setTimeout(resolve, 2100));
      }

      // Temporary failure
      mockFetch.mockRejectedValue(new Error('Temporary failure'));

      if (mockNetworkChangeCallback) {
        await mockNetworkChangeCallback(goodState);
        await new Promise(resolve => setTimeout(resolve, 2100));
      }

      // Recovery
      mockFetch.mockResolvedValue(new Response('', { status: 200 }));

      if (mockNetworkChangeCallback) {
        await mockNetworkChangeCallback(goodState);
        await new Promise(resolve => setTimeout(resolve, 2100));
      }

      // Should show recovery pattern
      expect(stateChanges).toContain('wifi-excellent');
      expect(stateChanges).toContain('wifi-unknown');
      expect(stateChanges.filter(s => s === 'wifi-excellent').length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Memory and Resource Management', () => {
    it('should limit history size to prevent memory leaks', async () => {
      const detector = new NetworkDetection();

      const networkState: NetInfoState = {
        type: 'wifi',
        isConnected: true,
        isInternetReachable: true,
        details: { isConnectionExpensive: false }
      };

      mockNetInfoFetch.mockResolvedValue(networkState);
      mockFetch.mockResolvedValue(new Response('', { status: 200 }));

      // Perform many detections to test history limiting
      for (let i = 0; i < 60; i++) {
        await detector.detectNetworkProfile();
      }

      const statistics = detector.getStatistics();

      // Should limit history to reasonable size (30-50 entries)
      expect(statistics.totalTests).toBeLessThanOrEqual(50);
      expect(statistics.totalTests).toBeGreaterThan(0);
    });

    it('should clean up resources on stop', () => {
      const unsubscribeFn = vi.fn();
      mockNetInfoAddEventListener.mockReturnValue(unsubscribeFn);

      networkDetection.start();
      networkDetection.stop();

      expect(unsubscribeFn).toHaveBeenCalled();

      // Verify internal state cleanup
      expect(networkDetection.getCurrentProfile()).toBeNull();
      expect(networkDetection.getCurrentStrategy()).toBeNull();
    });
  });
});

describe('Real-world Network Scenarios', () => {
  const mockNetInfoFetch = mockNetInfo.fetch as MockedFunction<typeof mockNetInfo.fetch>;
  const mockNetInfoAddEventListener = mockNetInfo.addEventListener as MockedFunction<typeof mockNetInfo.addEventListener>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  afterEach(() => {
    stopNetworkDetection();
  });

  it('should handle corporate firewall scenario', async () => {
    const detector = new NetworkDetection({}, mockNetInfo);

    const corporateState: NetInfoState = {
      type: 'wifi',
      isConnected: true,
      isInternetReachable: true,
      details: {
        isConnectionExpensive: false,
        ssid: 'CorpWiFi'
      }
    };

    mockNetInfoFetch.mockResolvedValue(corporateState);

    // Mock corporate firewall behavior - some requests fail, others are slow
    let requestCount = 0;
    mockFetch.mockImplementation(() => {
      requestCount++;
      if (requestCount % 3 === 0) {
        return Promise.reject(new Error('Blocked by firewall'));
      }
      return new Promise(resolve =>
        setTimeout(() => resolve(new Response('', { status: 200 })), 800) // Slow corporate network
      );
    });

    const profile = await detector.detectNetworkProfile();

    expect(profile.type).toBe('wifi');
    expect(profile.quality).toBe('poor'); // Should detect poor quality due to high latency
    expect(profile.stability).toBeLessThan(1.0); // Should detect instability due to failures

    const strategy = detector.getOptimalStrategy(profile);

    // Should be adjusted for corporate environment
    expect(strategy.retryPolicy.maxAttempts).toBeGreaterThan(3);
    expect(strategy.timeouts.connection).toBeGreaterThan(10000);
  });

  it('should handle mobile data caps (expensive networks)', async () => {
    const detector = new NetworkDetection({}, mockNetInfo);

    const expensiveState: NetInfoState = {
      type: 'cellular',
      isConnected: true,
      isInternetReachable: true,
      details: {
        isConnectionExpensive: true,
        cellularGeneration: '4g'
      }
    };

    mockNetInfoFetch.mockResolvedValue(expensiveState);
    mockFetch.mockResolvedValue(new Response('', { status: 200 }));

    const profile = await detector.detectNetworkProfile();

    expect(profile.isExpensive).toBe(true);
    expect(profile.type).toBe('cellular');

    const strategy = detector.getOptimalStrategy(profile);

    // Strategy should be conservative with data usage
    expect(strategy.heartbeatProfile).toBe('standard'); // Not too aggressive to save data
  });

  it('should optimize for 5G networks', async () => {
    const detector = new NetworkDetection({}, mockNetInfo);

    const fiveGState: NetInfoState = {
      type: 'cellular',
      isConnected: true,
      isInternetReachable: true,
      details: {
        isConnectionExpensive: true,
        cellularGeneration: '5g',
        strength: 90
      }
    };

    mockNetInfoFetch.mockResolvedValue(fiveGState);
    // Mock very fast 5G responses
    mockFetch.mockImplementation(() =>
      new Promise(resolve =>
        setTimeout(() => resolve(new Response('', { status: 200 })), 25) // Very fast
      )
    );

    const profile = await detector.detectNetworkProfile();

    expect(profile.generation).toBe('5g');
    expect(profile.quality).toBe('excellent');

    const strategy = detector.getOptimalStrategy(profile);

    // Should be optimized for fast, reliable 5G
    expect(strategy.timeouts.connection).toBeLessThan(10000);
    expect(strategy.retryPolicy.maxAttempts).toBeLessThanOrEqual(4);
  });
});