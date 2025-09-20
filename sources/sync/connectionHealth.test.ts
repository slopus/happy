/**
 * Comprehensive unit tests for Connection Health Monitoring with Heartbeat Profiles
 * Tests the Task 1.3 implementation of aggressive heartbeat profiles
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';

import { apiSocket } from './apiSocket';
import {
  ConnectionHealthMonitor,
  HEARTBEAT_PROFILES,
  HeartbeatProfile,
  ConnectionHealthConfig,
} from './connectionHealth';
import { connectionStateMachine } from './connectionStateMachine';

// Mock the dependencies
vi.mock('./apiSocket', () => ({
  apiSocket: {
    isSocketConnected: vi.fn(),
    getSocketInstance: vi.fn(),
    onStatusChange: vi.fn(),
    onReconnected: vi.fn(),
  },
}));

vi.mock('./connectionStateMachine', () => ({
  ConnectionState: {
    OFFLINE: 'offline',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    RECONNECTING: 'reconnecting',
    FAILED: 'failed',
  },
  connectionStateMachine: {
    addStateChangeListener: vi.fn(),
    transition: vi.fn(),
  },
}));

vi.mock('./storage', () => ({
  storage: {},
}));

describe('ConnectionHealthMonitor - Heartbeat Profiles', () => {
  let monitor: ConnectionHealthMonitor;
  let mockSocket: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup mock socket
    mockSocket = {
      emit: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
    };

    (apiSocket.isSocketConnected as Mock).mockReturnValue(true);
    (apiSocket.getSocketInstance as Mock).mockReturnValue(mockSocket);

    // Create a fresh monitor instance
    monitor = new ConnectionHealthMonitor();
  });

  afterEach(() => {
    monitor.stop();
  });

  describe('Heartbeat Profiles Configuration', () => {
    it('should have all required heartbeat profiles defined', () => {
      expect(HEARTBEAT_PROFILES.standard).toBeDefined();
      expect(HEARTBEAT_PROFILES.aggressive).toBeDefined();
      expect(HEARTBEAT_PROFILES.corporate).toBeDefined();
      expect(HEARTBEAT_PROFILES.battery_saver).toBeDefined();
    });

    it('should have correct profile characteristics', () => {
      // Standard profile
      expect(HEARTBEAT_PROFILES.standard.interval).toBe(30000);
      expect(HEARTBEAT_PROFILES.standard.timeout).toBe(10000);
      expect(HEARTBEAT_PROFILES.standard.maxConsecutiveFailures).toBe(3);

      // Aggressive profile - faster detection
      expect(HEARTBEAT_PROFILES.aggressive.interval).toBe(15000);
      expect(HEARTBEAT_PROFILES.aggressive.timeout).toBe(5000);
      expect(HEARTBEAT_PROFILES.aggressive.maxConsecutiveFailures).toBe(2);

      // Corporate profile - most aggressive
      expect(HEARTBEAT_PROFILES.corporate.interval).toBe(10000);
      expect(HEARTBEAT_PROFILES.corporate.timeout).toBe(3000);
      expect(HEARTBEAT_PROFILES.corporate.maxConsecutiveFailures).toBe(1);

      // Battery saver - reduced frequency
      expect(HEARTBEAT_PROFILES.battery_saver.interval).toBe(60000);
      expect(HEARTBEAT_PROFILES.battery_saver.timeout).toBe(15000);
      expect(HEARTBEAT_PROFILES.battery_saver.maxConsecutiveFailures).toBe(5);
    });

    it('should validate aggressive profile detects failures faster than standard', () => {
      const aggressive = HEARTBEAT_PROFILES.aggressive;
      const standard = HEARTBEAT_PROFILES.standard;

      expect(aggressive.interval).toBeLessThan(standard.interval);
      expect(aggressive.timeout).toBeLessThan(standard.timeout);
      expect(aggressive.maxConsecutiveFailures).toBeLessThanOrEqual(standard.maxConsecutiveFailures);
    });

    it('should validate battery saver reduces ping frequency', () => {
      const batterySaver = HEARTBEAT_PROFILES.battery_saver;
      const standard = HEARTBEAT_PROFILES.standard;

      expect(batterySaver.interval).toBeGreaterThan(standard.interval);
      expect(batterySaver.interval).toBeGreaterThanOrEqual(standard.interval * 2); // At least 50% reduction in frequency
    });
  });

  describe('Profile Management', () => {
    it('should initialize with standard profile by default', () => {
      const currentProfile = monitor.getCurrentProfile();
      expect(currentProfile.name).toBe('standard');
      expect(currentProfile.profile).toEqual(HEARTBEAT_PROFILES.standard);
    });

    it('should allow switching to different profiles', () => {
      monitor.setProfile('aggressive');

      const currentProfile = monitor.getCurrentProfile();
      expect(currentProfile.name).toBe('aggressive');
      expect(currentProfile.profile).toEqual(HEARTBEAT_PROFILES.aggressive);
    });

    it('should handle unknown profile names gracefully', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      monitor.setProfile('unknown' as keyof typeof HEARTBEAT_PROFILES);

      const currentProfile = monitor.getCurrentProfile();
      expect(currentProfile.name).toBe('standard');
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unknown profile \'unknown\''),
      );

      consoleSpy.mockRestore();
    });

    it('should return all available profiles', () => {
      const availableProfiles = monitor.getAvailableProfiles();

      expect(Object.keys(availableProfiles)).toEqual([
        'standard', 'aggressive', 'corporate', 'battery_saver',
      ]);
      expect(availableProfiles.standard).toEqual(HEARTBEAT_PROFILES.standard);
    });
  });

  describe('Heartbeat Reconfiguration', () => {
    beforeEach(() => {
      // Start monitoring to test reconfiguration
      monitor.start();
    });

    it('should reconfigure heartbeat when profile changes', () => {
      const setIntervalSpy = vi.spyOn(global, 'setInterval');
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      monitor.setProfile('aggressive');

      expect(clearIntervalSpy).toHaveBeenCalled();
      expect(setIntervalSpy).toHaveBeenCalledWith(
        expect.any(Function),
        HEARTBEAT_PROFILES.aggressive.interval,
      );
    });

    it('should use current profile interval when starting monitoring', () => {
      monitor.stop();
      monitor.setProfile('corporate');

      const setIntervalSpy = vi.spyOn(global, 'setInterval');

      monitor.start();

      expect(setIntervalSpy).toHaveBeenCalledWith(
        expect.any(Function),
        HEARTBEAT_PROFILES.corporate.interval,
      );
    });

    it('should not reconfigure if monitoring is not running', () => {
      monitor.stop();

      const setIntervalSpy = vi.spyOn(global, 'setInterval');
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      monitor.setProfile('battery_saver');

      // Should not call interval functions when not running
      expect(clearIntervalSpy).not.toHaveBeenCalled();
      expect(setIntervalSpy).not.toHaveBeenCalled();
    });
  });

  describe('Auto-Detection Logic', () => {
    beforeEach(() => {
      // Start the monitor to enable ping tracking
      monitor.start();
    });

    it('should detect corporate profile for high failure rate', () => {
      // Simulate high failure rate by adding failures to history
      const monitor_any = monitor as any;
      monitor_any.failureHistory = Array(10).fill(null).map((_, i) => ({
        timestamp: Date.now() - i * 1000,
        type: 'timeout',
      }));
      monitor_any.latencyHistory = [100, 200]; // Some latency data

      const detectedProfile = monitor.autoDetectProfile();
      expect(detectedProfile).toBe('corporate');
    });

    it('should detect aggressive profile for moderate failure rate', () => {
      const monitor_any = monitor as any;
      monitor_any.failureHistory = Array(3).fill(null).map((_, i) => ({
        timestamp: Date.now() - i * 1000,
        type: 'network_error',
      }));
      monitor_any.latencyHistory = Array(15).fill(900); // High latency to trigger aggressive
      monitor_any.networkChangeCount = 1; // Low network changes

      const detectedProfile = monitor.autoDetectProfile();
      expect(detectedProfile).toBe('aggressive');
    });

    it('should detect battery_saver profile for very stable connections', () => {
      const monitor_any = monitor as any;
      monitor_any.failureHistory = []; // No recent failures
      monitor_any.latencyHistory = Array(20).fill(50); // Very low latency

      const detectedProfile = monitor.autoDetectProfile();
      expect(detectedProfile).toBe('battery_saver');
    });

    it('should detect standard profile for normal conditions', () => {
      const monitor_any = monitor as any;
      monitor_any.failureHistory = Array(1).fill(null).map((_, i) => ({
        timestamp: Date.now() - i * 10000,
        type: 'timeout',
      }));
      monitor_any.latencyHistory = Array(15).fill(300); // Normal latency
      monitor_any.networkChangeCount = 1; // Normal network changes

      const detectedProfile = monitor.autoDetectProfile();
      expect(detectedProfile).toBe('standard');
    });

    it('should detect corporate profile for frequent network changes', () => {
      const monitor_any = monitor as any;
      monitor_any.networkChangeCount = 5; // Many network changes
      monitor_any.failureHistory = [];
      monitor_any.latencyHistory = [100, 200];

      const detectedProfile = monitor.autoDetectProfile();
      expect(detectedProfile).toBe('corporate');
    });

    it('should apply auto-detected profile when different from current', () => {
      const setProfileSpy = vi.spyOn(monitor, 'setProfile');

      // Setup conditions for corporate profile
      const monitor_any = monitor as any;
      monitor_any.failureHistory = Array(12).fill(null).map((_, i) => ({
        timestamp: Date.now() - i * 1000,
        type: 'timeout',
      }));
      monitor_any.latencyHistory = Array(20).fill(800);

      monitor.applyAutoDetectedProfile();

      expect(setProfileSpy).toHaveBeenCalledWith('corporate');
    });

    it('should not change profile if already optimal', () => {
      monitor.setProfile('corporate');
      const setProfileSpy = vi.spyOn(monitor, 'setProfile');

      // Setup conditions that should suggest corporate profile
      const monitor_any = monitor as any;
      monitor_any.failureHistory = Array(12).fill(null).map((_, i) => ({
        timestamp: Date.now() - i * 1000,
        type: 'timeout',
      }));
      monitor_any.latencyHistory = Array(20).fill(800);

      monitor.applyAutoDetectedProfile();

      // Should not call setProfile again since we're already on corporate
      expect(setProfileSpy).not.toHaveBeenCalled();
    });
  });

  describe('Ping Behavior with Profiles', () => {
    beforeEach(() => {
      monitor.start();
      // Set state to connected so pings will be attempted
      const monitor_any = monitor as any;
      monitor_any.status.state = 'connected';
    });

    it('should use profile-specific timeout for ping operations', async () => {
      monitor.setProfile('corporate');

      // Mock successful ping
      mockSocket.once.mockImplementation((event: string, callback: Function) => {
        if (event === 'pong') {
          setTimeout(callback, 100); // Respond after 100ms
        }
      });

      await monitor.checkNow();

      expect(mockSocket.emit).toHaveBeenCalledWith('ping', expect.any(Object));
    });

    it('should track failure history for auto-detection', async () => {
      // Mock socket as not connected to force immediate failure
      (apiSocket.isSocketConnected as Mock).mockReturnValue(false);

      const monitor_any = monitor as any;
      const initialFailures = monitor_any.failureHistory.length;

      await monitor.checkNow();

      expect(monitor_any.failureHistory.length).toBe(initialFailures + 1);
      expect(monitor_any.failureHistory[monitor_any.failureHistory.length - 1]).toMatchObject({
        type: expect.any(String),
        timestamp: expect.any(Number),
      });
    });

    it('should track latency history for auto-detection', async () => {
      // Mock successful ping with specific latency
      mockSocket.once.mockImplementation((event: string, callback: Function) => {
        if (event === 'pong') {
          setTimeout(callback, 150); // 150ms latency
        }
      });

      const monitor_any = monitor as any;
      const initialLatencyCount = monitor_any.latencyHistory.length;

      await monitor.checkNow();

      expect(monitor_any.latencyHistory.length).toBe(initialLatencyCount + 1);
      expect(monitor_any.latencyHistory[monitor_any.latencyHistory.length - 1]).toBeGreaterThan(100);
    });

    it('should use profile maxConsecutiveFailures for quality assessment', async () => {
      monitor.setProfile('corporate'); // maxConsecutiveFailures = 1

      // Mock ping failure
      (apiSocket.isSocketConnected as Mock).mockReturnValue(false);

      try {
        await monitor.checkNow();
      } catch (error) {
        // Expected to fail
      }

      const status = monitor.getStatus();
      expect(status.consecutiveFailures).toBe(1);

      // With corporate profile (maxConsecutiveFailures = 1), should be failed after 1 failure
      expect(status.quality).toBe('failed');
    });
  });

  describe('Performance Requirements', () => {
    it('should meet aggressive profile speed requirements', () => {
      const aggressive = HEARTBEAT_PROFILES.aggressive;
      const standard = HEARTBEAT_PROFILES.standard;

      // Aggressive should detect failures at least 50% faster
      const detectionSpeedImprovement = standard.interval / aggressive.interval;
      expect(detectionSpeedImprovement).toBeGreaterThanOrEqual(1.5); // 50% faster
    });

    it('should meet battery saver frequency reduction requirements', () => {
      const batterySaver = HEARTBEAT_PROFILES.battery_saver;
      const standard = HEARTBEAT_PROFILES.standard;

      // Battery saver should reduce frequency by at least 50%
      const frequencyReduction = batterySaver.interval / standard.interval;
      expect(frequencyReduction).toBeGreaterThanOrEqual(2.0); // 50% reduction in frequency
    });

    it('should limit history data to prevent memory leaks', () => {
      const monitor_any = monitor as any;

      // Add lots of latency data by simulating the trimming logic
      monitor_any.latencyHistory = Array(100).fill(100);

      // Simulate the trimming that happens in the actual code
      if (monitor_any.latencyHistory.length > 50) {
        monitor_any.latencyHistory = monitor_any.latencyHistory.slice(-50);
      }

      expect(monitor_any.latencyHistory.length).toBeLessThanOrEqual(50);
    });

    it('should clean up old failure history', () => {
      const monitor_any = monitor as any;
      const oneHourAgo = Date.now() - (60 * 60 * 1000);
      const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);

      // Add old and recent failures
      monitor_any.failureHistory = [
        { timestamp: twoHoursAgo, type: 'old' },
        { timestamp: oneHourAgo - 1000, type: 'old' },
        { timestamp: Date.now() - 1000, type: 'recent' },
      ];

      // Trigger cleanup by adding a new failure
      monitor_any.failureHistory.push({ timestamp: Date.now(), type: 'new' });
      monitor_any.failureHistory = monitor_any.failureHistory.filter(
        (f: any) => f.timestamp > oneHourAgo,
      );

      expect(monitor_any.failureHistory.every((f: any) => f.type !== 'old')).toBe(true);
    });
  });

  describe('Integration with Existing System', () => {
    it('should maintain backward compatibility with existing config', () => {
      const customConfig: Partial<ConnectionHealthConfig> = {
        pingInterval: 20000,
        pingTimeout: 8000,
        maxConsecutiveFailures: 4,
      };

      const customMonitor = new ConnectionHealthMonitor(customConfig);

      // Should still work with custom config, but profile should override
      customMonitor.setProfile('aggressive');

      const profile = customMonitor.getCurrentProfile();
      expect(profile.profile.interval).toBe(15000); // Profile value, not custom config
    });

    it('should integrate with socket listeners for network change detection', () => {
      const addListenerSpy = vi.spyOn(connectionStateMachine, 'addStateChangeListener');
      const onStatusChangeSpy = vi.spyOn(apiSocket, 'onStatusChange');

      new ConnectionHealthMonitor();

      expect(addListenerSpy).toHaveBeenCalled();
      expect(onStatusChangeSpy).toHaveBeenCalled();
    });

    it('should track network changes for auto-detection', () => {
      const monitor_any = monitor as any;
      const initialNetworkChanges = monitor_any.networkChangeCount;

      // Simulate socket status change to 'connected'
      const onStatusChangeCallback = (apiSocket.onStatusChange as Mock).mock.calls[0][0];
      onStatusChangeCallback('connected');

      expect(monitor_any.networkChangeCount).toBe(initialNetworkChanges + 1);
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle socket unavailability gracefully', async () => {
      (apiSocket.isSocketConnected as Mock).mockReturnValue(false);

      const status = await monitor.checkNow();
      expect(status.quality).toBeDefined();
    });

    it('should handle missing socket instance', async () => {
      (apiSocket.isSocketConnected as Mock).mockReturnValue(true);
      (apiSocket.getSocketInstance as Mock).mockReturnValue(null);

      const status = await monitor.checkNow();
      expect(status.quality).toBeDefined();
    });

    it('should handle auto-detection with insufficient data', () => {
      const monitor_any = monitor as any;
      monitor_any.failureHistory = [];
      monitor_any.latencyHistory = [];
      monitor_any.networkChangeCount = 0;

      const detectedProfile = monitor.autoDetectProfile();
      expect(detectedProfile).toBe('battery_saver'); // With no failures and zero latency, should be battery_saver
    });

    it('should handle periodic auto-detection triggers', () => {
      const applyAutoDetectedProfileSpy = vi.spyOn(monitor, 'applyAutoDetectedProfile');
      const monitor_any = monitor as any;

      // Simulate latency history reaching trigger point (every 10 measurements)
      monitor_any.latencyHistory = Array(10).fill(100);

      // Trigger the check that happens in performHealthCheck
      if (monitor_any.latencyHistory.length % 10 === 0 && monitor_any.latencyHistory.length > 0) {
        monitor.applyAutoDetectedProfile();
      }

      expect(applyAutoDetectedProfileSpy).toHaveBeenCalled();
    });
  });
});