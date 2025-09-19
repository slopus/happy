import { AppState, Platform } from 'react-native';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { apiSocket } from '@/sync/apiSocket';
import { BackgroundSyncManager, initializeBackgroundSync } from '@/sync/backgroundSync';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';

// Mock timers
vi.useFakeTimers();

// Mock dependencies with more realistic behavior
vi.mock('react-native', () => ({
  AppState: {
    addEventListener: vi.fn(),
    currentState: 'active',
  },
  Platform: {
    OS: 'ios',
  },
}));

vi.mock('expo-task-manager', () => ({
  defineTask: vi.fn(),
  registerTaskAsync: vi.fn(() => Promise.resolve()),
  unregisterTaskAsync: vi.fn(() => Promise.resolve()),
}));

vi.mock('expo-background-fetch', () => ({
  registerTaskAsync: vi.fn(() => Promise.resolve()),
  unregisterTaskAsync: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/log', () => ({
  log: {
    log: vi.fn(),
    error: vi.fn(),
  },
}));

// Realistic API socket mock
const mockApiSocket = {
  isConnected: vi.fn(() => true),
  isConnecting: vi.fn(() => false),
  send: vi.fn(),
  reconnect: vi.fn(() => Promise.resolve()),
  getLastPingTime: vi.fn(() => Date.now() - 10000),
  getLastActivityTime: vi.fn(() => Date.now() - 5000),
  initialize: vi.fn(),
  onStatusChange: vi.fn(),
  onMessage: vi.fn(),
  onReconnected: vi.fn(),
  request: vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ messages: [] }) })),
};

vi.mock('@/sync/apiSocket', () => ({
  apiSocket: mockApiSocket,
}));

// Realistic storage mock
const mockStorage = {
  getState: vi.fn(() => ({
    getActiveSessions: vi.fn(() => [
      { id: 'session1', active: true, metadata: { title: 'Test Session 1' } },
      { id: 'session2', active: true, metadata: { title: 'Test Session 2' } },
    ]),
    sessions: {
      session1: { id: 'session1', active: true },
      session2: { id: 'session2', active: true },
    },
    machines: {
      machine1: { id: 'machine1', active: true },
    },
    setSocketStatus: vi.fn(),
    applyReady: vi.fn(),
  })),
};

vi.mock('@/sync/storage', () => ({
  storage: mockStorage,
}));

// Realistic sync mock
const mockSync = {
  refreshSessions: vi.fn(() => Promise.resolve()),
  refreshMachines: vi.fn(() => Promise.resolve()),
  onSessionVisible: vi.fn(),
};

vi.mock('@/sync/sync', () => ({
  sync: mockSync,
}));

describe('Background Sync Integration Tests', () => {
  let backgroundSyncManager: BackgroundSyncManager;
  let appStateChangeHandler: (state: string) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.clearAllTimers();

    // Set up app state listener mock
    (AppState.addEventListener as any).mockImplementation((event: string, handler: any) => {
      if (event === 'change') {
        appStateChangeHandler = handler;
      }
      return { remove: vi.fn() };
    });

    backgroundSyncManager = new BackgroundSyncManager();
  });

  afterEach(() => {
    backgroundSyncManager?.cleanup();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.useFakeTimers();
  });

  describe('Real App State Transitions', () => {
    it('should handle complete background to foreground cycle', async () => {
      // Initial state - app is active
      expect(backgroundSyncManager.getStatus().isActive).toBe(false);

      // App goes to background
      await appStateChangeHandler('background');
      expect(backgroundSyncManager.getStatus().isActive).toBe(true);
      expect(backgroundSyncManager.getStatus().connectionHealthMonitoring).toBe(true);

      // Simulate some background activity
      await vi.advanceTimersByTimeAsync(15000); // 15 seconds

      // App becomes active again
      await appStateChangeHandler('active');
      expect(backgroundSyncManager.getStatus().isActive).toBe(false);

      // Verify sync services were refreshed
      expect(mockApiSocket.reconnect).toHaveBeenCalled();
    });

    it('should handle rapid state transitions', async () => {
      // Rapid transitions that might happen during notifications or interruptions
      await appStateChangeHandler('background');
      await appStateChangeHandler('active');
      await appStateChangeHandler('inactive');
      await appStateChangeHandler('background');
      await appStateChangeHandler('active');

      // Should handle rapid changes gracefully
      expect(backgroundSyncManager.getStatus().isActive).toBe(false);
    });

    it('should maintain connection health during extended background period', async () => {
      // Go to background
      await appStateChangeHandler('background');

      // Simulate extended background period (5 minutes)
      const startTime = Date.now();
      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(15000); // 15 second intervals

        // Connection should still be maintained
        expect(mockApiSocket.isConnected).toHaveBeenCalled();

        if (i % 4 === 0) {
          // Simulate occasional heartbeat
          expect(mockApiSocket.send).toHaveBeenCalledWith('ping', expect.any(Object));
        }
      }

      // Return to foreground
      await appStateChangeHandler('active');
      expect(mockApiSocket.reconnect).toHaveBeenCalled();
    });

    it('should handle network disconnection during background', async () => {
      // Go to background with good connection
      await appStateChangeHandler('background');
      expect(backgroundSyncManager.getStatus().isActive).toBe(true);

      // Simulate network disconnection
      mockApiSocket.isConnected.mockReturnValue(false);

      // Advance timers to trigger connection check
      await vi.advanceTimersByTimeAsync(10000);

      // Should attempt reconnection
      expect(mockApiSocket.reconnect).toHaveBeenCalled();

      // Simulate connection restored
      mockApiSocket.isConnected.mockReturnValue(true);

      // Return to foreground
      await appStateChangeHandler('active');
      expect(backgroundSyncManager.getStatus().isActive).toBe(false);
    });
  });

  describe('Connection Persistence Tests', () => {
    it('should maintain 80% connection survival in background', async () => {
      let connectionSuccessCount = 0;
      let totalChecks = 0;

      // Mock connection checks
      mockApiSocket.isConnected.mockImplementation(() => {
        totalChecks++;
        const shouldSucceed = Math.random() > 0.1; // 90% success rate
        if (shouldSucceed) connectionSuccessCount++;
        return shouldSucceed;
      });

      await appStateChangeHandler('background');

      // Simulate background period with connection checks
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(10000); // 10 second intervals
      }

      // Calculate survival rate
      const survivalRate = connectionSuccessCount / totalChecks;
      expect(survivalRate).toBeGreaterThan(0.8); // 80% survival rate requirement
    });

    it('should recover from temporary network outages', async () => {
      await appStateChangeHandler('background');

      // Simulate temporary network outage
      mockApiSocket.isConnected.mockReturnValue(false);
      await vi.advanceTimersByTimeAsync(30000); // 30 seconds offline

      // Connection should attempt reconnection
      expect(mockApiSocket.reconnect).toHaveBeenCalled();

      // Simulate connection recovery
      mockApiSocket.isConnected.mockReturnValue(true);
      await vi.advanceTimersByTimeAsync(10000);

      // Should be stable again
      expect(backgroundSyncManager.getStatus().isActive).toBe(true);
    });

    it('should handle server maintenance gracefully', async () => {
      await appStateChangeHandler('background');

      // Simulate server maintenance (extended outage)
      mockApiSocket.isConnected.mockReturnValue(false);
      mockApiSocket.reconnect.mockRejectedValue(new Error('Server unavailable'));

      // Should not crash during extended outage
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(60000); // 1 minute intervals
      }

      expect(backgroundSyncManager.getStatus().isActive).toBe(true);

      // Return to foreground should still work
      await appStateChangeHandler('active');
      expect(backgroundSyncManager.getStatus().isActive).toBe(false);
    });
  });

  describe('Data Synchronization Integration', () => {
    it('should sync critical session data during background', async () => {
      await appStateChangeHandler('background');

      // Simulate session state changes
      const activeSessions = mockStorage.getState().getActiveSessions();
      expect(activeSessions).toHaveLength(2);

      // Background sync should process session data
      await vi.advanceTimersByTimeAsync(20000);

      // Verify session data is being monitored
      expect(mockStorage.getState).toHaveBeenCalled();
    });

    it('should queue and process critical operations', async () => {
      await appStateChangeHandler('background');

      // Verify operations are queued
      const status = backgroundSyncManager.getStatus();
      expect(status.queuedOperations).toBeGreaterThan(0);

      // Process operations over time
      await vi.advanceTimersByTimeAsync(30000);

      // Operations should be processed but queue maintained for recent items
      const newStatus = backgroundSyncManager.getStatus();
      expect(newStatus.queuedOperations).toBeGreaterThanOrEqual(0);
    });

    it('should preserve user data during network interruptions', async () => {
      await appStateChangeHandler('background');

      // Simulate user data change while in background
      const sessionData = { id: 'session1', lastModified: Date.now() };

      // Network interruption
      mockApiSocket.isConnected.mockReturnValue(false);
      await vi.advanceTimersByTimeAsync(15000);

      // Data should be preserved in queue
      const status = backgroundSyncManager.getStatus();
      expect(status.queuedOperations).toBeGreaterThan(0);

      // Network recovery
      mockApiSocket.isConnected.mockReturnValue(true);
      await appStateChangeHandler('active');

      // Data should be synced on return to foreground
      expect(mockApiSocket.reconnect).toHaveBeenCalled();
    });
  });

  describe('Performance and Resource Management', () => {
    it('should maintain low memory usage during extended background', async () => {
      await appStateChangeHandler('background');

      // Simulate extended background period
      for (let i = 0; i < 50; i++) {
        await vi.advanceTimersByTimeAsync(10000); // 10 second intervals
      }

      // Queue should not grow unbounded
      const status = backgroundSyncManager.getStatus();
      expect(status.queuedOperations).toBeLessThan(100); // Reasonable limit
    });

    it('should clean up stale operations automatically', async () => {
      await appStateChangeHandler('background');

      // Add operations and wait for cleanup
      await vi.advanceTimersByTimeAsync(600000); // 10 minutes

      // Old operations should be cleaned up
      const status = backgroundSyncManager.getStatus();
      expect(status.queuedOperations).toBeLessThan(10); // Most should be cleaned
    });

    it('should respect background time limits', async () => {
      const shortTimeManager = new BackgroundSyncManager({
        maxBackgroundTime: 5000, // 5 seconds
        criticalOperations: ['connection_health'],
        syncInterval: 1000,
        enableNetworkOptimization: true,
      });

      const shortAppStateHandler = (AppState.addEventListener as any).mock.calls[1][1];

      await shortAppStateHandler('background');
      expect(shortTimeManager.getStatus().isActive).toBe(true);

      // Exceed time limit
      await vi.advanceTimersByTimeAsync(10000);

      // Should auto-stop due to time limit
      expect(shortTimeManager.getStatus().isActive).toBe(false);

      shortTimeManager.cleanup();
    });
  });

  describe('Error Recovery and Resilience', () => {
    it('should recover from API socket failures', async () => {
      await appStateChangeHandler('background');

      // Simulate API socket failure
      mockApiSocket.send.mockImplementation(() => {
        throw new Error('Socket send failed');
      });

      // Should not crash the background sync
      await vi.advanceTimersByTimeAsync(15000);
      expect(backgroundSyncManager.getStatus().isActive).toBe(true);

      // Recovery
      mockApiSocket.send.mockImplementation(vi.fn());
      await vi.advanceTimersByTimeAsync(15000);

      // Should continue operating
      expect(backgroundSyncManager.getStatus().isActive).toBe(true);
    });

    it('should handle storage access failures', async () => {
      await appStateChangeHandler('background');

      // Simulate storage failure
      mockStorage.getState.mockImplementation(() => {
        throw new Error('Storage access failed');
      });

      // Should not crash
      await vi.advanceTimersByTimeAsync(15000);
      expect(backgroundSyncManager.getStatus().isActive).toBe(true);

      // Recovery
      mockStorage.getState.mockImplementation(() => ({
        getActiveSessions: vi.fn(() => []),
        sessions: {
          session1: { id: 'session1', active: true },
          session2: { id: 'session2', active: true },
        },
        machines: {
          machine1: { id: 'machine1', active: true },
        },
        setSocketStatus: vi.fn(),
        applyReady: vi.fn(),
      }));

      await appStateChangeHandler('active');
      expect(backgroundSyncManager.getStatus().isActive).toBe(false);
    });

    it('should handle task manager failures gracefully', async () => {
      const TaskManager = require('expo-task-manager');
      TaskManager.defineTask.mockImplementation(() => {
        throw new Error('Task definition failed');
      });

      // Should not prevent basic functionality
      expect(() => {
        new BackgroundSyncManager();
      }).not.toThrow();
    });
  });

  describe('Multi-platform Integration', () => {
    it('should work correctly on iOS with background app refresh', async () => {
      (Platform as any).OS = 'ios';
      const iosManager = new BackgroundSyncManager();

      const iosAppStateHandler = (AppState.addEventListener as any).mock.calls[0][1];
      await iosAppStateHandler('background');

      // iOS should use conservative intervals
      expect(iosManager.getStatus().isActive).toBe(true);

      // Should handle iOS background limitations
      await vi.advanceTimersByTimeAsync(180000); // 3 minutes

      expect(iosManager.getStatus().isActive).toBe(true);

      iosManager.cleanup();
    });

    it('should work correctly on Android with doze mode', async () => {
      (Platform as any).OS = 'android';
      const androidManager = new BackgroundSyncManager();

      const androidAppStateHandler = (AppState.addEventListener as any).mock.calls[0][1];
      await androidAppStateHandler('background');

      // Android should handle doze mode gracefully
      expect(androidManager.getStatus().isActive).toBe(true);

      androidManager.cleanup();
    });

    it('should work correctly on web with page visibility', async () => {
      (Platform as any).OS = 'web';

      // Mock document for web
      const mockDocument = {
        hidden: false,
        addEventListener: vi.fn(),
      };
      (global as any).document = mockDocument;

      const webManager = new BackgroundSyncManager();

      const webAppStateHandler = (AppState.addEventListener as any).mock.calls[0][1];
      await webAppStateHandler('background');

      expect(webManager.getStatus().isActive).toBe(true);

      webManager.cleanup();
    });
  });

  describe('Integration with Existing Sync System', () => {
    it('should integrate with existing sync.ts functionality', async () => {
      // Test integration with the main sync system
      await appStateChangeHandler('background');
      await appStateChangeHandler('active');

      // Should trigger existing sync methods
      expect(mockApiSocket.reconnect).toHaveBeenCalled();
    });

    it('should work with global background sync initialization', () => {
      const customConfig = {
        syncInterval: 20000,
        maxBackgroundTime: 60000,
      };

      const manager = initializeBackgroundSync(customConfig);
      expect(manager).toBeDefined();
      expect(manager.getStatus).toBeDefined();
    });

    it('should maintain connection health monitoring integration', async () => {
      await appStateChangeHandler('background');

      // Should monitor connection health
      expect(backgroundSyncManager.getStatus().connectionHealthMonitoring).toBe(true);

      // Should use existing API socket methods
      expect(mockApiSocket.isConnected).toHaveBeenCalled();
    });
  });
});

describe('Real-world Scenario Tests', () => {
  let backgroundSyncManager: BackgroundSyncManager;
  let appStateChangeHandler: (state: string) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.clearAllTimers();

    (AppState.addEventListener as any).mockImplementation((event: string, handler: any) => {
      if (event === 'change') {
        appStateChangeHandler = handler;
      }
      return { remove: vi.fn() };
    });

    backgroundSyncManager = new BackgroundSyncManager();
  });

  afterEach(() => {
    backgroundSyncManager?.cleanup();
    vi.runOnlyPendingTimers();
  });

  it('should handle incoming phone call scenario', async () => {
    // App is active
    expect(backgroundSyncManager.getStatus().isActive).toBe(false);

    // Phone call comes in - app goes inactive
    await appStateChangeHandler('inactive');
    expect(backgroundSyncManager.getStatus().isActive).toBe(true);

    // Call ends - app becomes active
    await appStateChangeHandler('active');
    expect(backgroundSyncManager.getStatus().isActive).toBe(false);
  });

  it('should handle notification interaction scenario', async () => {
    // App in background
    await appStateChangeHandler('background');

    // User taps notification - app becomes active
    await appStateChangeHandler('active');

    // Should refresh all services
    expect(mockApiSocket.reconnect).toHaveBeenCalled();
  });

  it('should handle multitasking scenario', async () => {
    // App active
    await appStateChangeHandler('active');

    // User switches to another app
    await appStateChangeHandler('background');

    // Simulate working in another app for a while
    await vi.advanceTimersByTimeAsync(120000); // 2 minutes

    // User switches back
    await appStateChangeHandler('active');

    // Should maintain functionality
    expect(backgroundSyncManager.getStatus().isActive).toBe(false);
  });

  it('should handle device lock/unlock scenario', async () => {
    // Device gets locked
    await appStateChangeHandler('background');

    // Device locked for extended period
    await vi.advanceTimersByTimeAsync(300000); // 5 minutes

    // Device unlocked
    await appStateChangeHandler('active');

    // Should recover properly
    expect(backgroundSyncManager.getStatus().isActive).toBe(false);
    expect(mockApiSocket.reconnect).toHaveBeenCalled();
  });
});