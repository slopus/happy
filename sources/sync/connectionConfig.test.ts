import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  CONNECTION_CONFIG,
  LEGACY_CONNECTION_CONFIG,
  getConnectionConfig,
  setConnectionConfigOverride,
  clearConnectionConfigOverride,
  getEffectiveConnectionConfig,
  isEnhancedConnectionManagementEnabled,
  getEnhancedFeaturesStatus,
  type ConnectionConfig,
  type EnhancedFeatures,
} from './connectionConfig';

describe('connectionConfig', () => {
  beforeEach(() => {
    // Clear any runtime overrides before each test
    clearConnectionConfigOverride();

    // Clear environment variable mock
    delete process.env.EXPO_PUBLIC_DISABLE_ENHANCED_CONNECTION;
  });

  afterEach(() => {
    // Clean up after each test
    clearConnectionConfigOverride();
    delete process.env.EXPO_PUBLIC_DISABLE_ENHANCED_CONNECTION;
  });

  describe('CONNECTION_CONFIG', () => {
    it('should have enhanced connection management enabled by default', () => {
      expect(CONNECTION_CONFIG.enableEnhancedConnectionManagement).toBe(true);
    });

    it('should have reasonable default timeout values', () => {
      expect(CONNECTION_CONFIG.heartbeatInterval).toBe(30000);
      expect(CONNECTION_CONFIG.connectionTimeout).toBe(15000);
      expect(CONNECTION_CONFIG.maxReconnectAttempts).toBe(5);
      expect(CONNECTION_CONFIG.reconnectionDelay).toBe(2000);
    });

    it('should have enhanced features enabled by default', () => {
      expect(CONNECTION_CONFIG.enableConnectionHealthMonitoring).toBe(true);
      expect(CONNECTION_CONFIG.enableStaleConnectionCleanup).toBe(true);
      expect(CONNECTION_CONFIG.enableSessionStatePersistence).toBe(true);
      expect(CONNECTION_CONFIG.enableExponentialBackoff).toBe(true);
    });

    it('should have reasonable health monitoring defaults', () => {
      expect(CONNECTION_CONFIG.healthCheckInterval).toBe(60000);
      expect(CONNECTION_CONFIG.maxConsecutiveFailures).toBe(3);
      expect(CONNECTION_CONFIG.staleConnectionThreshold).toBe(300000);
      expect(CONNECTION_CONFIG.cleanupInterval).toBe(120000);
    });

    it('should have reasonable retry configuration', () => {
      expect(CONNECTION_CONFIG.baseRetryDelay).toBe(1000);
      expect(CONNECTION_CONFIG.maxRetryDelay).toBe(30000);
      expect(CONNECTION_CONFIG.retryJitter).toBe(true);
    });
  });

  describe('LEGACY_CONNECTION_CONFIG', () => {
    it('should disable enhanced connection management', () => {
      expect(LEGACY_CONNECTION_CONFIG.enableEnhancedConnectionManagement).toBe(false);
    });

    it('should disable all enhanced features', () => {
      expect(LEGACY_CONNECTION_CONFIG.enableConnectionHealthMonitoring).toBe(false);
      expect(LEGACY_CONNECTION_CONFIG.enableStaleConnectionCleanup).toBe(false);
      expect(LEGACY_CONNECTION_CONFIG.enableSessionStatePersistence).toBe(false);
    });

    it('should inherit other configuration from CONNECTION_CONFIG', () => {
      expect(LEGACY_CONNECTION_CONFIG.heartbeatInterval).toBe(CONNECTION_CONFIG.heartbeatInterval);
      expect(LEGACY_CONNECTION_CONFIG.connectionTimeout).toBe(CONNECTION_CONFIG.connectionTimeout);
      expect(LEGACY_CONNECTION_CONFIG.maxReconnectAttempts).toBe(CONNECTION_CONFIG.maxReconnectAttempts);
    });
  });

  describe('getConnectionConfig', () => {
    it('should return CONNECTION_CONFIG by default', () => {
      const config = getConnectionConfig();
      expect(config).toBe(CONNECTION_CONFIG);
      expect(config.enableEnhancedConnectionManagement).toBe(true);
    });

    it('should return LEGACY_CONNECTION_CONFIG when enhanced features are disabled via environment', () => {
      process.env.EXPO_PUBLIC_DISABLE_ENHANCED_CONNECTION = 'true';

      const config = getConnectionConfig();
      expect(config).toBe(LEGACY_CONNECTION_CONFIG);
      expect(config.enableEnhancedConnectionManagement).toBe(false);
    });

    it('should return CONNECTION_CONFIG when environment variable is not "true"', () => {
      process.env.EXPO_PUBLIC_DISABLE_ENHANCED_CONNECTION = 'false';

      const config = getConnectionConfig();
      expect(config).toBe(CONNECTION_CONFIG);
      expect(config.enableEnhancedConnectionManagement).toBe(true);
    });

    it('should return CONNECTION_CONFIG when environment variable is undefined', () => {
      delete process.env.EXPO_PUBLIC_DISABLE_ENHANCED_CONNECTION;

      const config = getConnectionConfig();
      expect(config).toBe(CONNECTION_CONFIG);
      expect(config.enableEnhancedConnectionManagement).toBe(true);
    });
  });

  describe('runtime configuration overrides', () => {
    it('should apply runtime overrides', () => {
      const override: Partial<ConnectionConfig> = {
        heartbeatInterval: 15000,
        maxReconnectAttempts: 10,
      };

      setConnectionConfigOverride(override);

      const config = getEffectiveConnectionConfig();
      expect(config.heartbeatInterval).toBe(15000);
      expect(config.maxReconnectAttempts).toBe(10);
      expect(config.enableEnhancedConnectionManagement).toBe(true); // unchanged
    });

    it('should disable enhanced features via runtime override', () => {
      const override: Partial<ConnectionConfig> = {
        enableEnhancedConnectionManagement: false,
      };

      setConnectionConfigOverride(override);

      const config = getEffectiveConnectionConfig();
      expect(config.enableEnhancedConnectionManagement).toBe(false);
    });

    it('should clear runtime overrides', () => {
      const override: Partial<ConnectionConfig> = {
        heartbeatInterval: 15000,
      };

      setConnectionConfigOverride(override);
      expect(getEffectiveConnectionConfig().heartbeatInterval).toBe(15000);

      clearConnectionConfigOverride();
      expect(getEffectiveConnectionConfig().heartbeatInterval).toBe(CONNECTION_CONFIG.heartbeatInterval);
    });

    it('should handle multiple override calls', () => {
      setConnectionConfigOverride({ heartbeatInterval: 15000 });
      setConnectionConfigOverride({ maxReconnectAttempts: 10 });

      const config = getEffectiveConnectionConfig();
      expect(config.heartbeatInterval).toBe(CONNECTION_CONFIG.heartbeatInterval); // overridden by second call
      expect(config.maxReconnectAttempts).toBe(10);
    });

    it('should combine environment and runtime overrides correctly', () => {
      process.env.EXPO_PUBLIC_DISABLE_ENHANCED_CONNECTION = 'true';
      setConnectionConfigOverride({ heartbeatInterval: 15000 });

      const config = getEffectiveConnectionConfig();
      expect(config.enableEnhancedConnectionManagement).toBe(false); // from environment
      expect(config.heartbeatInterval).toBe(15000); // from runtime override
    });
  });

  describe('isEnhancedConnectionManagementEnabled', () => {
    it('should return true by default', () => {
      expect(isEnhancedConnectionManagementEnabled()).toBe(true);
    });

    it('should return false when disabled via environment', () => {
      process.env.EXPO_PUBLIC_DISABLE_ENHANCED_CONNECTION = 'true';
      expect(isEnhancedConnectionManagementEnabled()).toBe(false);
    });

    it('should return false when disabled via runtime override', () => {
      setConnectionConfigOverride({ enableEnhancedConnectionManagement: false });
      expect(isEnhancedConnectionManagementEnabled()).toBe(false);
    });

    it('should respect runtime override over environment variable', () => {
      process.env.EXPO_PUBLIC_DISABLE_ENHANCED_CONNECTION = 'true';
      setConnectionConfigOverride({ enableEnhancedConnectionManagement: true });
      expect(isEnhancedConnectionManagementEnabled()).toBe(true);
    });
  });

  describe('getEnhancedFeaturesStatus', () => {
    it('should return all features enabled by default', () => {
      const features = getEnhancedFeaturesStatus();
      const expectedFeatures: EnhancedFeatures = {
        connectionHealthMonitoring: true,
        staleConnectionCleanup: true,
        sessionStatePersistence: true,
        adaptiveRetryLogic: true,
        improvedErrorRecovery: true,
      };

      expect(features).toEqual(expectedFeatures);
    });

    it('should return all features disabled when enhanced management is disabled', () => {
      setConnectionConfigOverride({ enableEnhancedConnectionManagement: false });

      const features = getEnhancedFeaturesStatus();
      const expectedFeatures: EnhancedFeatures = {
        connectionHealthMonitoring: false,
        staleConnectionCleanup: false,
        sessionStatePersistence: false,
        adaptiveRetryLogic: false,
        improvedErrorRecovery: false,
      };

      expect(features).toEqual(expectedFeatures);
    });

    it('should disable individual features when their flags are disabled', () => {
      setConnectionConfigOverride({
        enableConnectionHealthMonitoring: false,
        enableStaleConnectionCleanup: false,
      });

      const features = getEnhancedFeaturesStatus();
      expect(features.connectionHealthMonitoring).toBe(false);
      expect(features.staleConnectionCleanup).toBe(false);
      expect(features.sessionStatePersistence).toBe(true); // still enabled
      expect(features.adaptiveRetryLogic).toBe(true); // still enabled
      expect(features.improvedErrorRecovery).toBe(true); // depends on main flag
    });

    it('should disable adaptive retry logic when exponential backoff is disabled', () => {
      setConnectionConfigOverride({ enableExponentialBackoff: false });

      const features = getEnhancedFeaturesStatus();
      expect(features.adaptiveRetryLogic).toBe(false);
      expect(features.connectionHealthMonitoring).toBe(true); // other features still enabled
    });

    it('should handle environment variable correctly', () => {
      process.env.EXPO_PUBLIC_DISABLE_ENHANCED_CONNECTION = 'true';

      const features = getEnhancedFeaturesStatus();
      Object.values(features).forEach(feature => {
        expect(feature).toBe(false);
      });
    });
  });

  describe('configuration consistency', () => {
    it('should have consistent timeout relationships', () => {
      const config = CONNECTION_CONFIG;

      // Connection timeout should be reasonable relative to heartbeat
      expect(config.connectionTimeout).toBeLessThan(config.heartbeatInterval);

      // Heartbeat should be much less than stale connection threshold
      expect(config.heartbeatInterval).toBeLessThan(config.staleConnectionThreshold / 5);

      // Cleanup interval should be less than stale threshold
      expect(config.cleanupInterval).toBeLessThan(config.staleConnectionThreshold);
    });

    it('should have reasonable retry configuration', () => {
      const config = CONNECTION_CONFIG;

      expect(config.baseRetryDelay).toBeGreaterThan(0);
      expect(config.maxRetryDelay).toBeGreaterThan(config.baseRetryDelay);
      expect(config.maxReconnectAttempts).toBeGreaterThan(0);
    });

    it('should have positive intervals and thresholds', () => {
      const config = CONNECTION_CONFIG;

      expect(config.heartbeatInterval).toBeGreaterThan(0);
      expect(config.connectionTimeout).toBeGreaterThan(0);
      expect(config.reconnectionDelay).toBeGreaterThan(0);
      expect(config.healthCheckInterval).toBeGreaterThan(0);
      expect(config.staleConnectionThreshold).toBeGreaterThan(0);
      expect(config.cleanupInterval).toBeGreaterThan(0);
      expect(config.persistenceDebounceDelay).toBeGreaterThan(0);
      expect(config.maxConsecutiveFailures).toBeGreaterThan(0);
    });
  });

  describe('type safety', () => {
    it('should handle partial configuration overrides correctly', () => {
      const partialConfig: Partial<ConnectionConfig> = {
        heartbeatInterval: 45000,
      };

      setConnectionConfigOverride(partialConfig);
      const config = getEffectiveConnectionConfig();

      // Should have the override value
      expect(config.heartbeatInterval).toBe(45000);

      // Should preserve other values
      expect(config.enableEnhancedConnectionManagement).toBe(CONNECTION_CONFIG.enableEnhancedConnectionManagement);
      expect(config.connectionTimeout).toBe(CONNECTION_CONFIG.connectionTimeout);
    });

    it('should handle empty configuration override', () => {
      setConnectionConfigOverride({});
      const config = getEffectiveConnectionConfig();

      expect(config).toEqual(CONNECTION_CONFIG);
    });

    it('should maintain type safety with enhanced features', () => {
      const features: EnhancedFeatures = getEnhancedFeaturesStatus();

      // Ensure all expected properties exist and are boolean
      expect(typeof features.connectionHealthMonitoring).toBe('boolean');
      expect(typeof features.staleConnectionCleanup).toBe('boolean');
      expect(typeof features.sessionStatePersistence).toBe('boolean');
      expect(typeof features.adaptiveRetryLogic).toBe('boolean');
      expect(typeof features.improvedErrorRecovery).toBe('boolean');
    });
  });

  describe('backward compatibility', () => {
    it('should maintain backward compatibility when enhanced features are disabled', () => {
      process.env.EXPO_PUBLIC_DISABLE_ENHANCED_CONNECTION = 'true';

      const config = getConnectionConfig();
      const features = getEnhancedFeaturesStatus();

      // Should act like V1 configuration
      expect(config.enableEnhancedConnectionManagement).toBe(false);
      expect(features.connectionHealthMonitoring).toBe(false);
      expect(features.staleConnectionCleanup).toBe(false);
      expect(features.sessionStatePersistence).toBe(false);

      // But should preserve basic connection parameters
      expect(config.heartbeatInterval).toBeGreaterThan(0);
      expect(config.connectionTimeout).toBeGreaterThan(0);
      expect(config.maxReconnectAttempts).toBeGreaterThan(0);
    });

    it('should preserve legacy behavior for basic connection management', () => {
      const config = LEGACY_CONNECTION_CONFIG;

      // Should have same basic timeouts as enhanced config
      expect(config.heartbeatInterval).toBe(CONNECTION_CONFIG.heartbeatInterval);
      expect(config.connectionTimeout).toBe(CONNECTION_CONFIG.connectionTimeout);
      expect(config.maxReconnectAttempts).toBe(CONNECTION_CONFIG.maxReconnectAttempts);
      expect(config.reconnectionDelay).toBe(CONNECTION_CONFIG.reconnectionDelay);
    });
  });
});