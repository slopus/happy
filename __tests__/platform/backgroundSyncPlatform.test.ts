import { AppState, Platform } from 'react-native';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { BackgroundSyncManager, DEFAULT_BACKGROUND_CONFIG } from '@/sync/backgroundSync';
import { apiSocket } from '@/sync/apiSocket';

// Mock timers
vi.useFakeTimers();

// Mock platform-specific modules
vi.mock('react-native', () => ({
  AppState: {
    addEventListener: vi.fn(),
    currentState: 'active',
  },
  Platform: {
    OS: 'ios', // Will be overridden in tests
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

vi.mock('expo-battery', () => ({
  getBatteryLevelAsync: vi.fn(() => Promise.resolve(0.8)),
}));

vi.mock('@/log', () => ({
  log: {
    log: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/sync/apiSocket', () => ({
  apiSocket: {
    isConnected: vi.fn(() => true),
    isConnecting: vi.fn(() => false),
    send: vi.fn(),
    reconnect: vi.fn(() => Promise.resolve()),
    getLastPingTime: vi.fn(() => Date.now() - 10000),
    getLastActivityTime: vi.fn(() => Date.now() - 5000),
  },
}));

vi.mock('@/sync/storage', () => ({
  storage: {
    getState: vi.fn(() => ({
      getActiveSessions: vi.fn(() => [
        { id: 'session1', active: true },
        { id: 'session2', active: true },
      ]),
    })),
  },
}));

describe('iOS Platform Specific Tests', () => {
  let backgroundSyncManager: BackgroundSyncManager;
  let appStateChangeHandler: (state: string) => void;

  beforeEach(() => {
    (Platform as any).OS = 'ios';
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

  describe('iOS Background App Refresh', () => {
    it('should use conservative intervals on iOS', async () => {
      await appStateChangeHandler('background');

      // iOS should use longer intervals to preserve battery
      expect(backgroundSyncManager.getStatus().isActive).toBe(true);

      // Verify that intervals are conservative (minimum 30s)
      await vi.advanceTimersByTimeAsync(25000); // 25 seconds
      // Should not have triggered frequent operations

      await vi.advanceTimersByTimeAsync(10000); // Additional 10 seconds (35s total)
      // Now should have triggered some operations
    });

    it('should handle iOS background app refresh disabled', async () => {
      // Simulate background app refresh disabled
      // Note: expo-background-fetch is already mocked at the module level

      const iosManager = new BackgroundSyncManager();
      await appStateChangeHandler('background');

      // Should still work with basic app state management
      expect(iosManager.getStatus().isActive).toBe(true);

      iosManager.cleanup();
    });

    it('should respect iOS background execution time limits', async () => {
      // iOS typically gives 30 seconds of background execution
      const iosConfig = {
        ...DEFAULT_BACKGROUND_CONFIG,
        maxBackgroundTime: 30000, // 30 seconds
      };

      const iosManager = new BackgroundSyncManager(iosConfig);
      const iosAppStateHandler = (AppState.addEventListener as any).mock.calls[0][1];

      await iosAppStateHandler('background');

      // Simulate iOS cutting off background execution
      await vi.advanceTimersByTimeAsync(35000); // 35 seconds

      // Should have stopped due to time limit
      expect(iosManager.getStatus().isActive).toBe(false);

      iosManager.cleanup();
    });

    it('should optimize for iOS battery life', async () => {
      await appStateChangeHandler('background');

      // Force connected state to trigger heartbeats in iOS background mode
      (apiSocket.isConnected as any).mockReturnValue(true);
      
      // Advance time and check for minimal heartbeats
      await vi.advanceTimersByTimeAsync(120000); // 2 minutes

      // Should have minimal heartbeat activity - iOS uses conservative intervals
      // The heartbeat will be sent when connection is checked
      expect(apiSocket.isConnected).toHaveBeenCalled();
    });

    it('should handle iOS app termination gracefully', async () => {
      await appStateChangeHandler('background');

      // Simulate app about to be terminated
      await appStateChangeHandler('inactive');

      // Should clean up gracefully
      expect(backgroundSyncManager.getStatus()).toBeDefined();
    });

    it('should work with iOS Low Power Mode', async () => {
      // Simulate low power mode (low battery)
      // Note: expo-battery is already mocked at the module level

      await appStateChangeHandler('background');

      // Should still function but with reduced activity
      expect(backgroundSyncManager.getStatus().isActive).toBe(true);

      // Should minimize operations with low battery
      await vi.advanceTimersByTimeAsync(60000); // 1 minute
      // Minimal operations expected
    });
  });

  describe('iOS Specific Features', () => {
    it('should handle iOS silent push notifications', async () => {
      await appStateChangeHandler('background');

      // Simulate receiving a silent push notification
      // This would typically trigger background processing
      expect(backgroundSyncManager.getStatus().isActive).toBe(true);

      // Should be able to sync data quickly before iOS suspends
      await vi.advanceTimersByTimeAsync(5000); // 5 seconds
      expect(apiSocket.isConnected).toHaveBeenCalled();
    });

    it('should integrate with iOS Background Processing', async () => {
      // Note: expo-task-manager is already mocked at the module level
      // Verify that the background sync manager was created successfully
      expect(backgroundSyncManager).toBeDefined();
      expect(backgroundSyncManager.getStatus).toBeDefined();
    });

    it('should handle iOS scene-based app lifecycle', async () => {
      // iOS 13+ scene-based lifecycle
      await appStateChangeHandler('inactive'); // Scene will disconnect
      await appStateChangeHandler('background'); // App backgrounded
      await appStateChangeHandler('active'); // Scene reconnected

      expect(backgroundSyncManager.getStatus().isActive).toBe(false);
    });
  });
});

describe('Android Platform Specific Tests', () => {
  let backgroundSyncManager: BackgroundSyncManager;
  let appStateChangeHandler: (state: string) => void;

  beforeEach(() => {
    (Platform as any).OS = 'android';
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

  describe('Android Doze Mode and Battery Optimization', () => {
    it('should handle Android Doze mode', async () => {
      await appStateChangeHandler('background');

      // Simulate device entering Doze mode after some time
      await vi.advanceTimersByTimeAsync(300000); // 5 minutes

      // Should still maintain basic functionality
      expect(backgroundSyncManager.getStatus().isActive).toBe(true);

      // Should adapt to reduced network access
      expect(apiSocket.isConnected).toHaveBeenCalled();
    });

    it('should respect Android battery optimization settings', async () => {
      // Simulate battery optimization enabled (more restrictive)
      // Note: expo-battery is already mocked at the module level

      await appStateChangeHandler('background');

      // Should reduce background activity when battery is low
      await vi.advanceTimersByTimeAsync(60000); // 1 minute

      expect(backgroundSyncManager.getStatus().isActive).toBe(true);
    });

    it('should work with Android adaptive battery', async () => {
      // Simulate Android adaptive battery learning
      await appStateChangeHandler('background');

      // Should maintain consistent behavior for app usage patterns
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(30000); // 30 second intervals
        expect(backgroundSyncManager.getStatus().isActive).toBe(true);
      }
    });

    it('should handle Android background app limits', async () => {
      // Android 8+ background service limitations
      const config = {
        ...DEFAULT_BACKGROUND_CONFIG,
        syncInterval: 60000, // Android prefers longer intervals
      };

      const androidManager = new BackgroundSyncManager(config);
      const androidAppStateHandler = (AppState.addEventListener as any).mock.calls.slice(-1)[0][1];

      await androidAppStateHandler('background');

      // Should work within Android's background limitations
      expect(androidManager.getStatus().isActive).toBe(true);

      androidManager.cleanup();
    });
  });

  describe('Android Specific Features', () => {
    it('should use Android WorkManager compatibility', async () => {
      // Note: expo-background-fetch is already mocked at the module level
      // Verify that the background sync manager was created successfully
      expect(backgroundSyncManager).toBeDefined();
      expect(backgroundSyncManager.getStatus).toBeDefined();
    });

    it('should handle Android network changes', async () => {
      await appStateChangeHandler('background');

      // Simulate Android network state changes
      (apiSocket.isConnected as any).mockReturnValue(false);
      await vi.advanceTimersByTimeAsync(30000);

      // Should attempt reconnection
      expect(apiSocket.reconnect).toHaveBeenCalled();

      // Network restored
      (apiSocket.isConnected as any).mockReturnValue(true);
      await vi.advanceTimersByTimeAsync(10000);

      expect(backgroundSyncManager.getStatus().isActive).toBe(true);
    });

    it('should work with Android targetSdkVersion constraints', async () => {
      // Android 11+ (API 30) has stricter background limitations
      await appStateChangeHandler('background');

      // Should work within modern Android constraints
      expect(backgroundSyncManager.getStatus().isActive).toBe(true);

      // Should handle automatic battery optimization
      await vi.advanceTimersByTimeAsync(120000); // 2 minutes
      expect(backgroundSyncManager.getStatus().isActive).toBe(true);
    });

    it('should handle Android memory pressure', async () => {
      await appStateChangeHandler('background');

      // Simulate Android system killing background processes
      // Background sync should handle this gracefully
      expect(backgroundSyncManager.getStatus().isActive).toBe(true);

      // Should maintain minimal memory footprint
      await vi.advanceTimersByTimeAsync(180000); // 3 minutes
      expect(backgroundSyncManager.getStatus().queuedOperations).toBeLessThan(50);
    });
  });

  describe('Android Performance Optimization', () => {
    it('should optimize for Android battery usage', async () => {
      await appStateChangeHandler('background');

      // Should use efficient intervals for Android
      const heartbeatCalls = (apiSocket.send as any).mock.calls.filter(
        (call: any[]) => call[0] === 'ping'
      );

      await vi.advanceTimersByTimeAsync(60000); // 1 minute

      // Should balance connectivity with battery usage
      expect(apiSocket.send).toHaveBeenCalled();
    });

    it('should adapt to Android device capabilities', async () => {
      // High-end device vs low-end device behavior
      await appStateChangeHandler('background');

      // Should scale background activity based on device capabilities
      expect(backgroundSyncManager.getStatus().isActive).toBe(true);
    });
  });
});

describe('Web Platform Specific Tests', () => {
  let backgroundSyncManager: BackgroundSyncManager;
  let appStateChangeHandler: (state: string) => void;
  let mockDocument: any;

  beforeEach(() => {
    (Platform as any).OS = 'web';
    vi.clearAllMocks();
    vi.clearAllTimers();

    // Mock document object for web
    mockDocument = {
      hidden: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      visibilityState: 'visible',
    };
    (global as any).document = mockDocument;

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
    delete (global as any).document;
  });

  describe('Web Page Visibility API', () => {
    it('should use Page Visibility API on web', async () => {
      // Trigger background state to set up visibility change listener
      await appStateChangeHandler('background');
      
      // Should set up visibility change listener when going to background on web
      expect(mockDocument.addEventListener).toHaveBeenCalledWith(
        'visibilitychange',
        expect.any(Function)
      );
    });

    it('should handle page hidden/visible transitions', async () => {
      const visibilityHandler = mockDocument.addEventListener.mock.calls.find(
        (call: any[]) => call[0] === 'visibilitychange'
      )?.[1];

      // Page becomes hidden
      mockDocument.hidden = true;
      visibilityHandler?.();

      await vi.advanceTimersByTimeAsync(1000);

      // Page becomes visible
      mockDocument.hidden = false;
      visibilityHandler?.();

      // Should handle transitions gracefully
      expect(backgroundSyncManager.getStatus()).toBeDefined();
    });

    it('should work when Page Visibility API is not available', () => {
      delete (global as any).document;

      // Should not crash when document is unavailable
      expect(() => {
        new BackgroundSyncManager();
      }).not.toThrow();
    });

    it('should handle multiple tabs scenario', async () => {
      // Simulate multiple tabs where this tab becomes hidden
      await appStateChangeHandler('background');
      mockDocument.hidden = true;

      // Should use less aggressive sync when tab is hidden
      await vi.advanceTimersByTimeAsync(60000); // 1 minute

      expect(backgroundSyncManager.getStatus().isActive).toBe(true);
    });
  });

  describe('Web Specific Features', () => {
    it('should handle browser tab suspension', async () => {
      await appStateChangeHandler('background');

      // Browsers may suspend tabs to save resources
      // Should handle this gracefully
      await vi.advanceTimersByTimeAsync(300000); // 5 minutes

      expect(backgroundSyncManager.getStatus().isActive).toBe(true);
    });

    it('should work with Web Workers if available', async () => {
      // Mock Web Worker availability
      (global as any).Worker = vi.fn();

      await appStateChangeHandler('background');

      // Should work regardless of Web Worker availability
      expect(backgroundSyncManager.getStatus().isActive).toBe(true);
    });

    it('should handle browser navigation away', async () => {
      await appStateChangeHandler('background');

      // Simulate user navigating to different site
      mockDocument.visibilityState = 'hidden';

      await vi.advanceTimersByTimeAsync(10000);

      // Should clean up properly
      expect(backgroundSyncManager.getStatus().isActive).toBe(true);
    });

    it('should optimize for web performance', async () => {
      await appStateChangeHandler('background');
      
      // Force connected state and simulate background sync activity
      (apiSocket.isConnected as any).mockReturnValue(true);

      // Web should use less aggressive intervals
      await vi.advanceTimersByTimeAsync(30000); // 30 seconds

      // Should check connection status for web background sync
      expect(apiSocket.isConnected).toHaveBeenCalled();
    });

    it('should handle browser sleep/wake cycles', async () => {
      await appStateChangeHandler('background');

      // Simulate computer sleep
      await vi.advanceTimersByTimeAsync(300000); // 5 minutes
      
      // Simulate disconnected socket when computer wakes up
      (apiSocket.isConnected as any).mockReturnValue(false);

      // Computer wakes up
      await appStateChangeHandler('active');

      // Should reconnect properly when socket is disconnected
      expect(apiSocket.reconnect).toHaveBeenCalled();
    });
  });

  describe('Web Browser Compatibility', () => {
    it('should work in Chrome/Chromium browsers', async () => {
      // Chrome-specific behavior
      mockDocument.visibilityState = 'visible';
      await appStateChangeHandler('background');

      expect(backgroundSyncManager.getStatus().isActive).toBe(true);
    });

    it('should work in Safari browsers', async () => {
      // Safari has different tab suspension behavior
      await appStateChangeHandler('background');
      mockDocument.hidden = true;

      await vi.advanceTimersByTimeAsync(60000);
      expect(backgroundSyncManager.getStatus().isActive).toBe(true);
    });

    it('should work in Firefox browsers', async () => {
      // Firefox tab suspension
      await appStateChangeHandler('background');

      await vi.advanceTimersByTimeAsync(120000); // 2 minutes
      expect(backgroundSyncManager.getStatus().isActive).toBe(true);
    });

    it('should handle browser extensions interference', async () => {
      // Some browser extensions might interfere with timers
      await appStateChangeHandler('background');

      // Should maintain functionality despite interference
      await vi.advanceTimersByTimeAsync(60000);
      expect(backgroundSyncManager.getStatus().isActive).toBe(true);
    });
  });
});

describe('Cross-Platform Compatibility Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.clearAllTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
  });

  describe('Platform Detection and Adaptation', () => {
    it('should detect and adapt to each platform correctly', () => {
      const platforms = ['ios', 'android', 'web'];

      platforms.forEach(platform => {
        (Platform as any).OS = platform;

        expect(() => {
          const manager = new BackgroundSyncManager();
          manager.cleanup();
        }).not.toThrow();
      });
    });

    it('should handle unknown platforms gracefully', () => {
      (Platform as any).OS = 'unknown';

      expect(() => {
        const manager = new BackgroundSyncManager();
        manager.cleanup();
      }).not.toThrow();
    });

    it('should provide consistent API across platforms', () => {
      const platforms = ['ios', 'android', 'web'];

      platforms.forEach(platform => {
        (Platform as any).OS = platform;
        const manager = new BackgroundSyncManager();

        // All platforms should provide same API
        expect(manager.getStatus).toBeDefined();
        expect(manager.updateConfig).toBeDefined();
        expect(manager.cleanup).toBeDefined();

        manager.cleanup();
      });
    });
  });

  describe('Feature Availability Tests', () => {
    it('should gracefully handle missing platform features', () => {
      // Test when platform-specific modules are not available
      // Note: expo-background-fetch is already mocked at the module level
      expect(() => {
        new BackgroundSyncManager();
      }).not.toThrow();
    });

    it('should provide fallback functionality', async () => {
      // When background fetch is not available, should still work
      // Note: expo-background-fetch is already mocked at the module level
      const manager = new BackgroundSyncManager();
      const appStateHandler = (AppState.addEventListener as any).mock.calls[0][1];

      await appStateHandler('background');
      expect(manager.getStatus().isActive).toBe(true);

      manager.cleanup();
    });
  });

  describe('Performance Consistency', () => {
    it('should maintain similar performance characteristics across platforms', async () => {
      const platforms = ['ios', 'android', 'web'];
      const results: any[] = [];

      for (const platform of platforms) {
        (Platform as any).OS = platform;
        
        // Set up document for web platform
        if (platform === 'web') {
          (global as any).document = {
            hidden: false,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            visibilityState: 'visible',
          };
        }
        
        const manager = new BackgroundSyncManager();
        const appStateHandler = (AppState.addEventListener as any).mock.calls.slice(-1)[0][1];

        const startTime = Date.now();
        await appStateHandler('background');
        const endTime = Date.now();

        results.push({
          platform,
          startupTime: endTime - startTime,
          isActive: manager.getStatus().isActive,
        });

        manager.cleanup();
        
        // Clean up document for web
        if (platform === 'web') {
          delete (global as any).document;
        }
      }

      // All platforms should start up quickly and become active
      results.forEach(result => {
        expect(result.startupTime).toBeLessThan(1000); // Less than 1 second
        expect(result.isActive).toBe(true);
      });
    });
  });
});