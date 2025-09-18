/**
 * Connection Configuration
 * Controls various connection management features and behaviors
 */

export interface ConnectionConfig {
    // Enhanced Connection Management
    enableEnhancedConnectionManagement: boolean;

    // Connection timeouts
    maxReconnectAttempts: number;
    heartbeatInterval: number;
    connectionTimeout: number;
    reconnectionDelay: number;

    // Health monitoring
    enableConnectionHealthMonitoring: boolean;
    healthCheckInterval: number;
    maxConsecutiveFailures: number;

    // Cleanup and maintenance
    enableStaleConnectionCleanup: boolean;
    staleConnectionThreshold: number;
    cleanupInterval: number;

    // Session persistence
    enableSessionStatePersistence: boolean;
    persistenceDebounceDelay: number;

    // Retry configuration
    enableExponentialBackoff: boolean;
    baseRetryDelay: number;
    maxRetryDelay: number;
    retryJitter: boolean;
}

/**
 * Default connection configuration with enhanced features enabled
 * This represents the V2 connection logic configuration
 */
export const CONNECTION_CONFIG: ConnectionConfig = {
  // Enhanced Connection Management - ENABLED BY DEFAULT for V2
  enableEnhancedConnectionManagement: true,

  // Connection timeouts (in milliseconds)
  maxReconnectAttempts: 5,
  heartbeatInterval: 30000, // 30 seconds
  connectionTimeout: 15000, // 15 seconds
  reconnectionDelay: 2000, // 2 seconds

  // Health monitoring
  enableConnectionHealthMonitoring: true,
  healthCheckInterval: 60000, // 1 minute
  maxConsecutiveFailures: 3,

  // Cleanup and maintenance
  enableStaleConnectionCleanup: true,
  staleConnectionThreshold: 300000, // 5 minutes
  cleanupInterval: 120000, // 2 minutes

  // Session persistence
  enableSessionStatePersistence: true,
  persistenceDebounceDelay: 1000, // 1 second

  // Retry configuration
  enableExponentialBackoff: true,
  baseRetryDelay: 1000, // 1 second
  maxRetryDelay: 30000, // 30 seconds
  retryJitter: true,
};

/**
 * Legacy connection configuration (V1 compatibility mode)
 * For backward compatibility when enhanced features need to be disabled
 */
export const LEGACY_CONNECTION_CONFIG: ConnectionConfig = {
  ...CONNECTION_CONFIG,
  enableEnhancedConnectionManagement: false,
  enableConnectionHealthMonitoring: false,
  enableStaleConnectionCleanup: false,
  enableSessionStatePersistence: false,
};

/**
 * Get the current connection configuration
 * Can be overridden by environment variables or runtime configuration
 */
export function getConnectionConfig(): ConnectionConfig {
  // Check for environment override to disable enhanced features
  const forceDisableEnhanced = process.env.EXPO_PUBLIC_DISABLE_ENHANCED_CONNECTION === 'true';

  if (forceDisableEnhanced) {
    console.warn('🔧 Enhanced connection management disabled via environment variable');
    return LEGACY_CONNECTION_CONFIG;
  }

  return CONNECTION_CONFIG;
}

/**
 * Update connection configuration at runtime
 * Useful for debugging, testing, or dynamic configuration changes
 */
let runtimeConfig: Partial<ConnectionConfig> | null = null;

export function setConnectionConfigOverride(config: Partial<ConnectionConfig>): void {
  runtimeConfig = config;
  console.log('🔧 Connection config override applied:', config);
}

export function clearConnectionConfigOverride(): void {
  runtimeConfig = null;
  console.log('🔧 Connection config override cleared');
}

export function getEffectiveConnectionConfig(): ConnectionConfig {
  const baseConfig = getConnectionConfig();
  return runtimeConfig ? { ...baseConfig, ...runtimeConfig } : baseConfig;
}

/**
 * Check if enhanced connection management is enabled
 */
export function isEnhancedConnectionManagementEnabled(): boolean {
  return getEffectiveConnectionConfig().enableEnhancedConnectionManagement;
}

/**
 * Enhanced features summary - what gets enabled when enhanced management is on
 */
export interface EnhancedFeatures {
    connectionHealthMonitoring: boolean;
    staleConnectionCleanup: boolean;
    sessionStatePersistence: boolean;
    adaptiveRetryLogic: boolean;
    improvedErrorRecovery: boolean;
}

/**
 * Get current enhanced features status
 */
export function getEnhancedFeaturesStatus(): EnhancedFeatures {
  const config = getEffectiveConnectionConfig();

  return {
    connectionHealthMonitoring: config.enableEnhancedConnectionManagement && config.enableConnectionHealthMonitoring,
    staleConnectionCleanup: config.enableEnhancedConnectionManagement && config.enableStaleConnectionCleanup,
    sessionStatePersistence: config.enableEnhancedConnectionManagement && config.enableSessionStatePersistence,
    adaptiveRetryLogic: config.enableEnhancedConnectionManagement && config.enableExponentialBackoff,
    improvedErrorRecovery: config.enableEnhancedConnectionManagement,
  };
}