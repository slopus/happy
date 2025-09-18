/**
 * Unit tests for NetworkDetection
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

// Mock NetInfo
vi.mock('@react-native-community/netinfo', () => ({
  default: mockNetInfo
}));

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

import {
  NetworkDetection,
  NetworkProfile,
  ConnectionStrategy,
  NETWORK_STRATEGIES,
  networkDetection,
  startNetworkDetection,
  stopNetworkDetection,
  getCurrentNetworkProfile,
  getCurrentConnectionStrategy,
  type NetworkDetectionConfig,
  type LatencyTestResult
} from '@/sync/networkDetection';

describe('NetworkDetection', () => {
  let detector: NetworkDetection;
  const mockNetInfoFetch = mockNetInfo.fetch as MockedFunction<typeof mockNetInfo.fetch>;
  const mockNetInfoAddEventListener = mockNetInfo.addEventListener as MockedFunction<typeof mockNetInfo.addEventListener>;

  beforeEach(() => {
    detector = new NetworkDetection();
    vi.clearAllMocks();

    // Reset global fetch mock
    mockFetch.mockReset();
  });

  afterEach(() => {
    detector.stop();
  });

  describe('Network Type Detection', () => {
    it('should detect WiFi network correctly', async () => {
      const mockNetInfo: NetInfoState = {
        type: 'wifi',
        isConnected: true,
        isInternetReachable: true,
        details: {
          isConnectionExpensive: false,
          ssid: 'TestWiFi',
          strength: 75,
          ipAddress: '192.168.1.100',
          subnet: '255.255.255.0'
        }
      };

      mockNetInfoFetch.mockResolvedValue(mockNetInfo);
      mockFetch.mockResolvedValue(new Response('', { status: 200 }));

      const profile = await detector.detectNetworkProfile();

      expect(profile.type).toBe('wifi');
      expect(profile.isExpensive).toBe(false);
      expect(profile.isInternetReachable).toBe(true);
    });

    it('should detect cellular network correctly', async () => {
      const mockNetInfo: NetInfoState = {
        type: 'cellular',
        isConnected: true,
        isInternetReachable: true,
        details: {
          isConnectionExpensive: true,
          cellularGeneration: '4g',
          carrier: 'TestCarrier'
        }
      };

      mockNetInfoFetch.mockResolvedValue(mockNetInfo);
      mockFetch.mockResolvedValue(new Response('', { status: 200 }));

      const profile = await detector.detectNetworkProfile();

      expect(profile.type).toBe('cellular');
      expect(profile.isExpensive).toBe(true);
      expect(profile.generation).toBe('4g');
    });

    it('should detect ethernet network correctly', async () => {
      const mockNetInfo: NetInfoState = {
        type: 'ethernet',
        isConnected: true,
        isInternetReachable: true,
        details: {
          isConnectionExpensive: false,
          ipAddress: '10.0.0.100'
        }
      };

      mockNetInfoFetch.mockResolvedValue(mockNetInfo);
      mockFetch.mockResolvedValue(new Response('', { status: 200 }));

      const profile = await detector.detectNetworkProfile();

      expect(profile.type).toBe('ethernet');
      expect(profile.isExpensive).toBe(false);
    });

    it('should handle unknown network types', async () => {
      const mockNetInfo: NetInfoState = {
        type: 'other',
        isConnected: true,
        isInternetReachable: true,
        details: null
      };

      mockNetInfoFetch.mockResolvedValue(mockNetInfo);
      mockFetch.mockResolvedValue(new Response('', { status: 200 }));

      const profile = await detector.detectNetworkProfile();

      expect(profile.type).toBe('unknown');
    });
  });

  describe('Network Quality Assessment', () => {
    beforeEach(() => {
      const mockNetInfo: NetInfoState = {
        type: 'wifi',
        isConnected: true,
        isInternetReachable: true,
        details: {
          isConnectionExpensive: false,
          ssid: 'TestWiFi'
        }
      };
      mockNetInfoFetch.mockResolvedValue(mockNetInfo);
    });

    it('should assess excellent quality for low latency', async () => {
      // Mock fast responses (50ms latency)
      mockFetch.mockImplementation(() =>
        new Promise(resolve =>
          setTimeout(() => resolve(new Response('', { status: 200 })), 50)
        )
      );

      const profile = await detector.detectNetworkProfile();
      expect(profile.quality).toBe('excellent');
    });

    it('should assess good quality for moderate latency', async () => {
      // Mock moderate responses (200ms latency)
      mockFetch.mockImplementation(() =>
        new Promise(resolve =>
          setTimeout(() => resolve(new Response('', { status: 200 })), 200)
        )
      );

      const profile = await detector.detectNetworkProfile();
      expect(profile.quality).toBe('good');
    });

    it('should assess poor quality for high latency', async () => {
      // Mock slow responses (500ms latency)
      mockFetch.mockImplementation(() =>
        new Promise(resolve =>
          setTimeout(() => resolve(new Response('', { status: 200 })), 500)
        )
      );

      const profile = await detector.detectNetworkProfile();
      expect(profile.quality).toBe('poor');
    });

    it('should handle failed quality tests', async () => {
      // Mock failed requests
      mockFetch.mockRejectedValue(new Error('Network error'));

      const profile = await detector.detectNetworkProfile();
      expect(profile.quality).toBe('unknown');
    });

    it('should handle partial test failures', async () => {
      // Mock mixed success/failure
      let callCount = 0;
      mockFetch.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return new Promise(resolve =>
            setTimeout(() => resolve(new Response('', { status: 200 })), 100)
          );
        } else {
          return Promise.reject(new Error('Network error'));
        }
      });

      const profile = await detector.detectNetworkProfile();
      expect(profile.quality).toBe('excellent'); // Should still work with one success
    });
  });

  describe('Strategy Selection', () => {
    it('should select appropriate strategy for wifi-excellent', () => {
      const profile: NetworkProfile = {
        type: 'wifi',
        quality: 'excellent',
        stability: 0.95,
        strength: 85,
        isExpensive: false,
        isInternetReachable: true
      };

      const strategy = detector.getOptimalStrategy(profile);

      expect(strategy).toEqual(NETWORK_STRATEGIES['wifi-excellent']);
      expect(strategy.timeouts.connection).toBe(8000);
      expect(strategy.heartbeatProfile).toBe('standard');
    });

    it('should select appropriate strategy for cellular-poor', () => {
      const profile: NetworkProfile = {
        type: 'cellular',
        quality: 'poor',
        stability: 0.6,
        strength: 30,
        isExpensive: true,
        generation: '3g',
        isInternetReachable: true
      };

      const strategy = detector.getOptimalStrategy(profile);

      expect(strategy.timeouts.connection).toBeGreaterThan(15000);
      expect(strategy.retryPolicy.maxAttempts).toBeGreaterThanOrEqual(6);
      expect(strategy.heartbeatProfile).toBe('aggressive');
    });

    it('should use fallback strategy for unknown combinations', () => {
      const profile: NetworkProfile = {
        type: 'unknown',
        quality: 'unknown',
        stability: 0.5,
        strength: null,
        isExpensive: false,
        isInternetReachable: false
      };

      const strategy = detector.getOptimalStrategy(profile);

      expect(strategy).toEqual(NETWORK_STRATEGIES['unknown-default']);
    });

    it('should adjust strategy based on stability', () => {
      const profile: NetworkProfile = {
        type: 'wifi',
        quality: 'good',
        stability: 0.3, // Very unstable
        strength: 50,
        isExpensive: false,
        isInternetReachable: true
      };

      const strategy = detector.getOptimalStrategy(profile);

      // Should be adjusted for instability
      expect(strategy.retryPolicy.maxAttempts).toBeGreaterThan(NETWORK_STRATEGIES['wifi-good'].retryPolicy.maxAttempts);
      expect(strategy.heartbeatProfile).toBe('aggressive');
    });

    it('should optimize strategy for high stability', () => {
      const profile: NetworkProfile = {
        type: 'wifi',
        quality: 'good',
        stability: 0.98, // Very stable
        strength: 90,
        isExpensive: false,
        isInternetReachable: true
      };

      const strategy = detector.getOptimalStrategy(profile);

      // Should be optimized for stable connection
      expect(strategy.timeouts.heartbeat).toBeGreaterThan(NETWORK_STRATEGIES['wifi-good'].timeouts.heartbeat);
    });
  });

  describe('Cellular Generation Optimizations', () => {
    it('should adjust strategy for 3G networks', () => {
      const profile: NetworkProfile = {
        type: 'cellular',
        quality: 'good',
        stability: 0.8,
        strength: 60,
        isExpensive: true,
        generation: '3g',
        isInternetReachable: true
      };

      const strategy = detector.getOptimalStrategy(profile);

      expect(strategy.timeouts.connection).toBeGreaterThan(NETWORK_STRATEGIES['cellular-good'].timeouts.connection);
      expect(strategy.heartbeatProfile).toBe('aggressive');
    });

    it('should optimize strategy for 5G networks', () => {
      const profile: NetworkProfile = {
        type: 'cellular',
        quality: 'excellent',
        stability: 0.95,
        strength: 95,
        isExpensive: true,
        generation: '5g',
        isInternetReachable: true
      };

      const strategy = detector.getOptimalStrategy(profile);

      expect(strategy.timeouts.connection).toBeLessThan(NETWORK_STRATEGIES['cellular-excellent'].timeouts.connection);
    });
  });

  describe('Stability Calculation', () => {
    it('should return 1.0 for insufficient data', () => {
      const detector = new NetworkDetection();
      const statistics = detector.getStatistics();

      expect(statistics.currentStability).toBe(1.0);
    });

    it('should calculate stability based on success rate and latency variance', async () => {
      const mockNetInfo: NetInfoState = {
        type: 'wifi',
        isConnected: true,
        isInternetReachable: true,
        details: { isConnectionExpensive: false }
      };

      mockNetInfoFetch.mockResolvedValue(mockNetInfo);

      // Mock consistent fast responses for high stability
      mockFetch.mockImplementation(() =>
        new Promise(resolve =>
          setTimeout(() => resolve(new Response('', { status: 200 })), 95 + Math.random() * 10)
        )
      );

      // Perform multiple detections to build history
      for (let i = 0; i < 5; i++) {
        await detector.detectNetworkProfile();
      }

      const statistics = detector.getStatistics();
      expect(statistics.currentStability).toBeGreaterThan(0.8);
    });
  });

  describe('Network Monitoring', () => {
    it('should start and stop monitoring correctly', () => {
      const unsubscribeFn = vi.fn();
      mockNetInfoAddEventListener.mockReturnValue(unsubscribeFn);

      detector.start();
      expect(mockNetInfoAddEventListener).toHaveBeenCalledOnce();

      detector.stop();
      expect(unsubscribeFn).toHaveBeenCalledOnce();
    });

    it('should not start monitoring twice', () => {
      const unsubscribeFn = vi.fn();
      mockNetInfoAddEventListener.mockReturnValue(unsubscribeFn);

      detector.start();
      detector.start(); // Second call should be ignored

      expect(mockNetInfoAddEventListener).toHaveBeenCalledOnce();
    });

    it('should handle network change listeners', async () => {
      const mockListener = vi.fn();
      const unsubscribe = detector.addListener(mockListener);

      const mockNetInfo: NetInfoState = {
        type: 'wifi',
        isConnected: true,
        isInternetReachable: true,
        details: { isConnectionExpensive: false }
      };

      mockNetInfoFetch.mockResolvedValue(mockNetInfo);
      mockFetch.mockResolvedValue(new Response('', { status: 200 }));

      await detector.detectNetworkProfile();

      expect(mockListener).toHaveBeenCalled();

      unsubscribe();
    });

    it('should handle listener errors gracefully', async () => {
      const errorListener = vi.fn(() => {
        throw new Error('Listener error');
      });

      detector.addListener(errorListener);

      const mockNetInfo: NetInfoState = {
        type: 'wifi',
        isConnected: true,
        isInternetReachable: true,
        details: { isConnectionExpensive: false }
      };

      mockNetInfoFetch.mockResolvedValue(mockNetInfo);
      mockFetch.mockResolvedValue(new Response('', { status: 200 }));

      // Should not throw error
      expect(() => detector.detectNetworkProfile()).not.toThrow();
    });
  });

  describe('Statistics', () => {
    it('should provide accurate statistics', async () => {
      const mockNetInfo: NetInfoState = {
        type: 'wifi',
        isConnected: true,
        isInternetReachable: true,
        details: { isConnectionExpensive: false }
      };

      mockNetInfoFetch.mockResolvedValue(mockNetInfo);

      // Mock successful tests
      mockFetch.mockResolvedValue(new Response('', { status: 200 }));

      await detector.detectNetworkProfile();

      const statistics = detector.getStatistics();

      expect(statistics.totalTests).toBeGreaterThan(0);
      expect(statistics.successRate).toBe(1.0);
      expect(statistics.averageLatency).toBeGreaterThan(0);
      expect(statistics.lastProfileUpdate).toBeNull(); // Not tracking update times in this implementation
    });

    it('should handle mixed success/failure in statistics', async () => {
      const mockNetInfo: NetInfoState = {
        type: 'wifi',
        isConnected: true,
        isInternetReachable: true,
        details: { isConnectionExpensive: false }
      };

      mockNetInfoFetch.mockResolvedValue(mockNetInfo);

      // Mock mixed success/failure
      let callCount = 0;
      mockFetch.mockImplementation(() => {
        callCount++;
        if (callCount <= 2) {
          return Promise.resolve(new Response('', { status: 200 }));
        } else {
          return Promise.reject(new Error('Network error'));
        }
      });

      await detector.detectNetworkProfile();

      const statistics = detector.getStatistics();

      expect(statistics.totalTests).toBe(3);
      expect(statistics.successRate).toBe(2/3);
    });
  });

  describe('Global Singleton Functions', () => {
    afterEach(() => {
      stopNetworkDetection();
    });

    it('should start and stop global network detection', () => {
      const unsubscribeFn = vi.fn();
      mockNetInfoAddEventListener.mockReturnValue(unsubscribeFn);

      startNetworkDetection();
      expect(mockNetInfoAddEventListener).toHaveBeenCalled();

      stopNetworkDetection();
      expect(unsubscribeFn).toHaveBeenCalled();
    });

    it('should get current network profile', () => {
      const profile = getCurrentNetworkProfile();
      expect(profile).toBeNull(); // No profile detected yet
    });

    it('should get current connection strategy', () => {
      const strategy = getCurrentConnectionStrategy();
      expect(strategy).toBeNull(); // No strategy selected yet
    });
  });
});

describe('NETWORK_STRATEGIES Configuration', () => {
  it('should have all required strategy keys', () => {
    const expectedKeys = [
      'wifi-excellent',
      'wifi-good',
      'wifi-poor',
      'cellular-excellent',
      'cellular-good',
      'cellular-poor',
      'ethernet-excellent',
      'ethernet-good',
      'corporate-restricted',
      'unknown-default'
    ];

    expectedKeys.forEach(key => {
      expect(NETWORK_STRATEGIES[key]).toBeDefined();
    });
  });

  it('should have consistent strategy structure', () => {
    Object.keys(NETWORK_STRATEGIES).forEach(key => {
      const strategy = NETWORK_STRATEGIES[key];

      expect(strategy.timeouts).toBeDefined();
      expect(strategy.timeouts.connection).toBeGreaterThan(0);
      expect(strategy.timeouts.heartbeat).toBeGreaterThan(0);
      expect(strategy.timeouts.retry).toBeGreaterThan(0);

      expect(strategy.retryPolicy).toBeDefined();
      expect(strategy.retryPolicy.maxAttempts).toBeGreaterThan(0);
      expect(strategy.retryPolicy.backoffMultiplier).toBeGreaterThan(1);
      expect(strategy.retryPolicy.baseDelay).toBeGreaterThan(0);

      expect(strategy.heartbeatProfile).toBeDefined();
      expect(['standard', 'aggressive', 'corporate', 'battery_saver']).toContain(strategy.heartbeatProfile);
    });
  });

  it('should have appropriate timeout progressions', () => {
    // Excellent should have shorter timeouts than poor
    const wifiExcellent = NETWORK_STRATEGIES['wifi-excellent'];
    const wifiPoor = NETWORK_STRATEGIES['wifi-poor'];

    expect(wifiExcellent.timeouts.connection).toBeLessThan(wifiPoor.timeouts.connection);
    expect(wifiExcellent.retryPolicy.maxAttempts).toBeLessThanOrEqual(wifiPoor.retryPolicy.maxAttempts);
  });

  it('should use aggressive heartbeat for poor networks', () => {
    const poorStrategies = [
      'wifi-poor',
      'cellular-poor'
    ];

    poorStrategies.forEach(key => {
      expect(NETWORK_STRATEGIES[key].heartbeatProfile).toBe('aggressive');
    });
  });

  it('should use corporate profile for corporate-restricted', () => {
    expect(NETWORK_STRATEGIES['corporate-restricted'].heartbeatProfile).toBe('corporate');
  });
});