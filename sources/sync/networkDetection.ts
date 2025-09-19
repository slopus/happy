/**
 * Network-Aware Connection Strategies
 *
 * This module provides intelligent network detection and adaptive connection strategies
 * based on real-time network conditions. It automatically adjusts timeouts, retry policies,
 * and heartbeat profiles to optimize connection reliability across different network types.
 */


// Import NetInfo directly to allow proper mocking
let NetInfo: any;

try {
  // This will be mocked in tests
  NetInfo = require('@react-native-community/netinfo').default;
} catch {
  // Fallback for environments where NetInfo is not available
  NetInfo = {
    fetch: () => Promise.resolve({
      type: 'wifi',
      isConnected: true,
      isInternetReachable: true,
      details: { isConnectionExpensive: false }
    }),
    addEventListener: () => () => {} // Unsubscribe function
  };
}

// Use the global mock if it exists (for testing)
if (typeof global !== 'undefined' && (global as any).mockNetInfo) {
  NetInfo = (global as any).mockNetInfo;
}

// Type definitions for NetInfo (matching @react-native-community/netinfo)
export interface NetInfoStateType {
  wifi: 'wifi';
  cellular: 'cellular';
  ethernet: 'ethernet';
  bluetooth: 'bluetooth';
  wimax: 'wimax';
  vpn: 'vpn';
  other: 'other';
  unknown: 'unknown';
  none: 'none';
}

export interface NetInfoState {
  type: keyof NetInfoStateType;
  isConnected: boolean | null;
  isInternetReachable: boolean | null;
  details: any;
}

// Import types that will be available once Task 1.3 is completed
// For now, we'll define a placeholder that matches the expected interface
type HeartbeatProfileKey = 'standard' | 'aggressive' | 'corporate' | 'battery_saver';

export interface NetworkProfile {
  type: 'wifi' | 'cellular' | 'ethernet' | 'unknown';
  quality: 'excellent' | 'good' | 'poor' | 'unknown';
  stability: number; // 0-1 score based on recent history
  strength: number | null; // Signal strength where available
  isExpensive: boolean; // Cellular data cost consideration
  generation?: string; // Cellular generation (3g, 4g, 5g)
  isInternetReachable: boolean;
}

export interface ConnectionStrategy {
  timeouts: {
    connection: number;
    heartbeat: number;
    retry: number;
  };
  retryPolicy: {
    maxAttempts: number;
    backoffMultiplier: number;
    baseDelay: number;
  };
  heartbeatProfile: HeartbeatProfileKey;
}

/**
 * Pre-configured connection strategies for different network conditions
 */
export const NETWORK_STRATEGIES: Record<string, ConnectionStrategy> = {
  'wifi-excellent': {
    timeouts: { connection: 8000, heartbeat: 30000, retry: 1000 },
    retryPolicy: { maxAttempts: 3, backoffMultiplier: 1.5, baseDelay: 500 },
    heartbeatProfile: 'standard'
  },
  'wifi-good': {
    timeouts: { connection: 10000, heartbeat: 25000, retry: 1500 },
    retryPolicy: { maxAttempts: 4, backoffMultiplier: 1.7, baseDelay: 750 },
    heartbeatProfile: 'standard'
  },
  'wifi-poor': {
    timeouts: { connection: 15000, heartbeat: 15000, retry: 2000 },
    retryPolicy: { maxAttempts: 5, backoffMultiplier: 2.0, baseDelay: 1000 },
    heartbeatProfile: 'aggressive'
  },
  'cellular-excellent': {
    timeouts: { connection: 10000, heartbeat: 28000, retry: 1500 },
    retryPolicy: { maxAttempts: 3, backoffMultiplier: 1.6, baseDelay: 700 },
    heartbeatProfile: 'standard'
  },
  'cellular-good': {
    timeouts: { connection: 12000, heartbeat: 25000, retry: 2000 },
    retryPolicy: { maxAttempts: 4, backoffMultiplier: 1.8, baseDelay: 1000 },
    heartbeatProfile: 'standard'
  },
  'cellular-poor': {
    timeouts: { connection: 20000, heartbeat: 20000, retry: 3000 },
    retryPolicy: { maxAttempts: 6, backoffMultiplier: 2.5, baseDelay: 2000 },
    heartbeatProfile: 'aggressive'
  },
  'ethernet-excellent': {
    timeouts: { connection: 6000, heartbeat: 35000, retry: 800 },
    retryPolicy: { maxAttempts: 2, backoffMultiplier: 1.3, baseDelay: 400 },
    heartbeatProfile: 'standard'
  },
  'ethernet-good': {
    timeouts: { connection: 8000, heartbeat: 30000, retry: 1000 },
    retryPolicy: { maxAttempts: 3, backoffMultiplier: 1.5, baseDelay: 600 },
    heartbeatProfile: 'standard'
  },
  'corporate-restricted': {
    timeouts: { connection: 10000, heartbeat: 8000, retry: 1500 },
    retryPolicy: { maxAttempts: 8, backoffMultiplier: 1.2, baseDelay: 800 },
    heartbeatProfile: 'corporate'
  },
  'unknown-default': {
    timeouts: { connection: 12000, heartbeat: 20000, retry: 2000 },
    retryPolicy: { maxAttempts: 5, backoffMultiplier: 2.0, baseDelay: 1000 },
    heartbeatProfile: 'standard'
  }
};

/**
 * Configuration for network detection behavior
 */
export interface NetworkDetectionConfig {
  qualityTestUrls: string[];
  latencyThresholds: {
    excellent: number;
    good: number;
    poor: number;
  };
  stabilityWindow: number; // Number of samples for stability calculation
  testTimeout: number; // Timeout for individual latency tests
  adaptationDelay: number; // Delay before applying strategy changes
}

const DEFAULT_CONFIG: NetworkDetectionConfig = {
  qualityTestUrls: [
    'https://api.happy.engineering/ping',
    'https://1.1.1.1', // Cloudflare DNS
    'https://8.8.8.8'  // Google DNS
  ],
  latencyThresholds: {
    excellent: 100, // < 100ms
    good: 300,      // < 300ms
    poor: 800,      // < 800ms (above = unknown)
  },
  stabilityWindow: 10,
  testTimeout: 5000,
  adaptationDelay: 2000
};

/**
 * Interface for latency test results
 */
export interface LatencyTestResult {
  url: string;
  latency: number | null;
  success: boolean;
  timestamp: number;
}

/**
 * Interface for network change listeners
 */
export interface NetworkChangeListener {
  (profile: NetworkProfile, strategy: ConnectionStrategy): void;
}

/**
 * Main network detection and strategy management class
 */
export class NetworkDetection {
  private config: NetworkDetectionConfig;
  private currentProfile: NetworkProfile | null = null;
  private currentStrategy: ConnectionStrategy | null = null;
  private latencyHistory: LatencyTestResult[] = [];
  private stabilityHistory: number[] = [];
  private listeners = new Set<NetworkChangeListener>();
  private netInfoUnsubscribe: (() => void) | null = null;
  private isMonitoring = false;
  private adaptationTimer: ReturnType<typeof setTimeout> | null = null;
  private netInfo: any;

  constructor(config: Partial<NetworkDetectionConfig> = {}, netInfoInstance?: any) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.netInfo = netInfoInstance || NetInfo;
  }

  /**
   * Start network monitoring
   */
  start(): void {
    if (this.isMonitoring) return;

    this.isMonitoring = true;
    console.log('🌐 NetworkDetection: Starting network monitoring');

    // Subscribe to network state changes
    this.netInfoUnsubscribe = this.netInfo.addEventListener(this.handleNetworkStateChange.bind(this));

    // Perform initial network detection
    this.detectNetworkProfile();
  }

  /**
   * Stop network monitoring
   */
  stop(): void {
    if (!this.isMonitoring) return;

    this.isMonitoring = false;
    console.log('🌐 NetworkDetection: Stopping network monitoring');

    // Unsubscribe from network state changes
    if (this.netInfoUnsubscribe) {
      this.netInfoUnsubscribe();
      this.netInfoUnsubscribe = null;
    }

    // Clear adaptation timer
    if (this.adaptationTimer) {
      clearTimeout(this.adaptationTimer);
      this.adaptationTimer = null;
    }
  }

  /**
   * Get current network profile
   */
  getCurrentProfile(): NetworkProfile | null {
    return this.currentProfile ? { ...this.currentProfile } : null;
  }

  /**
   * Get current connection strategy
   */
  getCurrentStrategy(): ConnectionStrategy | null {
    return this.currentStrategy ? JSON.parse(JSON.stringify(this.currentStrategy)) : null;
  }

  /**
   * Add network change listener
   */
  addListener(listener: NetworkChangeListener): () => void {
    this.listeners.add(listener);

    // Immediately notify with current state if available
    if (this.currentProfile && this.currentStrategy) {
      try {
        listener(this.currentProfile, this.currentStrategy);
      } catch (error) {
        console.error('🌐 NetworkDetection: Error in listener:', error);
      }
    }

    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Force network profile detection
   */
  async detectNetworkProfile(): Promise<NetworkProfile> {
    const netInfo = await this.netInfo.fetch();
    const profile = await this.createNetworkProfile(netInfo);

    this.updateNetworkProfile(profile);
    return profile;
  }

  /**
   * Handle network state changes from NetInfo
   */
  private async handleNetworkStateChange(netInfo: NetInfoState): Promise<void> {
    console.log('🌐 NetworkDetection: Network state changed:', {
      type: netInfo.type,
      isConnected: netInfo.isConnected,
      isInternetReachable: netInfo.isInternetReachable
    });

    const profile = await this.createNetworkProfile(netInfo);
    this.scheduleProfileUpdate(profile);
  }

  /**
   * Create network profile from NetInfo state
   */
  private async createNetworkProfile(netInfo: NetInfoState): Promise<NetworkProfile> {
    const networkType = this.mapNetworkType(netInfo.type);
    const quality = netInfo.isConnected && netInfo.isInternetReachable
      ? await this.assessNetworkQuality()
      : 'unknown';

    const stability = this.calculateStability();
    const strength = this.extractSignalStrength(netInfo);
    const isExpensive = this.isNetworkExpensive(netInfo);
    const generation = this.extractCellularGeneration(netInfo);

    return {
      type: networkType,
      quality,
      stability,
      strength,
      isExpensive,
      generation,
      isInternetReachable: netInfo.isInternetReachable || false
    };
  }

  /**
   * Map NetInfo network type to our simplified type
   */
  private mapNetworkType(netInfoType: string): NetworkProfile['type'] {
    switch (netInfoType) {
      case 'wifi':
        return 'wifi';
      case 'cellular':
        return 'cellular';
      case 'ethernet':
        return 'ethernet';
      case 'bluetooth':
      case 'wimax':
      case 'vpn':
      case 'other':
      default:
        return 'unknown';
    }
  }

  /**
   * Assess network quality through latency testing
   */
  private async assessNetworkQuality(): Promise<NetworkProfile['quality']> {
    const testPromises = this.config.qualityTestUrls.map(url =>
      this.performLatencyTest(url)
    );

    try {
      const results = await Promise.allSettled(testPromises);
      const successfulResults = results
        .filter((result): result is PromiseFulfilledResult<LatencyTestResult> =>
          result.status === 'fulfilled' && result.value.success
        )
        .map(result => result.value);

      if (successfulResults.length === 0) {
        return 'unknown';
      }

      // Calculate average latency from successful tests
      const avgLatency = successfulResults.reduce((sum, result) =>
        sum + (result.latency || 0), 0
      ) / successfulResults.length;

      // Store results for stability calculation
      successfulResults.forEach(result => {
        this.latencyHistory.push(result);
      });

      // Keep only recent history
      if (this.latencyHistory.length > 50) {
        this.latencyHistory = this.latencyHistory.slice(-30);
      }

      // Determine quality based on latency thresholds
      if (avgLatency < this.config.latencyThresholds.excellent) return 'excellent';
      if (avgLatency < this.config.latencyThresholds.good) return 'good';
      if (avgLatency < this.config.latencyThresholds.poor) return 'poor';
      return 'unknown';

    } catch (error) {
      console.error('🌐 NetworkDetection: Quality assessment failed:', error);
      return 'unknown';
    }
  }

  /**
   * Perform latency test to a specific URL
   */
  private async performLatencyTest(url: string): Promise<LatencyTestResult> {
    const startTime = Date.now();

    try {
      // Use a simple fetch with timeout for latency testing
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.testTimeout);

      await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
        cache: 'no-cache'
      });

      clearTimeout(timeoutId);
      const latency = Date.now() - startTime;

      return {
        url,
        latency,
        success: true,
        timestamp: Date.now()
      };

    } catch {
      return {
        url,
        latency: null,
        success: false,
        timestamp: Date.now()
      };
    }
  }

  /**
   * Calculate network stability based on recent history
   */
  private calculateStability(): number {
    if (this.latencyHistory.length < 3) return 1.0;

    const recentResults = this.latencyHistory.slice(-this.config.stabilityWindow);
    const successRate = recentResults.filter(r => r.success).length / recentResults.length;

    // Calculate latency variance for successful tests
    const successfulLatencies = recentResults
      .filter(r => r.success && r.latency !== null)
      .map(r => r.latency!);

    if (successfulLatencies.length < 2) return successRate;

    const avgLatency = successfulLatencies.reduce((a, b) => a + b, 0) / successfulLatencies.length;
    const variance = successfulLatencies.reduce((acc, lat) =>
      acc + Math.pow(lat - avgLatency, 2), 0) / successfulLatencies.length;

    // Normalize variance to 0-1 scale
    const maxExpectedVariance = Math.max(avgLatency * avgLatency, 1); // Avoid division by zero
    const latencyStability = Math.max(0, 1 - (variance / maxExpectedVariance));

    // Combine success rate and latency stability
    const result = (successRate * 0.6) + (latencyStability * 0.4);
    return isNaN(result) ? successRate : result;
  }

  /**
   * Extract signal strength from NetInfo details
   */
  private extractSignalStrength(netInfo: NetInfoState): number | null {
    if (netInfo.type === 'cellular' && netInfo.details && 'strength' in netInfo.details) {
      return (netInfo.details as any).strength || null;
    }

    if (netInfo.type === 'wifi' && netInfo.details && 'strength' in netInfo.details) {
      return (netInfo.details as any).strength || null;
    }

    return null;
  }

  /**
   * Determine if network is expensive (cellular data)
   */
  private isNetworkExpensive(netInfo: NetInfoState): boolean {
    return netInfo.type === 'cellular';
  }

  /**
   * Extract cellular generation information
   */
  private extractCellularGeneration(netInfo: NetInfoState): string | undefined {
    if (netInfo.type === 'cellular' && netInfo.details && 'cellularGeneration' in netInfo.details) {
      const generation = (netInfo.details as any).cellularGeneration;
      return generation || undefined;
    }
    return undefined;
  }

  /**
   * Schedule profile update with debouncing
   */
  private scheduleProfileUpdate(profile: NetworkProfile): void {
    if (this.adaptationTimer) {
      clearTimeout(this.adaptationTimer);
    }

    this.adaptationTimer = setTimeout(() => {
      this.updateNetworkProfile(profile);
    }, this.config.adaptationDelay);
  }

  /**
   * Update network profile and select optimal strategy
   */
  private updateNetworkProfile(profile: NetworkProfile): void {
    const hasChanged = !this.currentProfile ||
      this.currentProfile.type !== profile.type ||
      this.currentProfile.quality !== profile.quality ||
      Math.abs(this.currentProfile.stability - profile.stability) > 0.1;

    if (!hasChanged) return;

    console.log('🌐 NetworkDetection: Profile updated:', {
      type: profile.type,
      quality: profile.quality,
      stability: isNaN(profile.stability) ? '0.00' : profile.stability.toFixed(2),
      isExpensive: profile.isExpensive,
      generation: profile.generation
    });

    this.currentProfile = profile;
    this.currentStrategy = this.getOptimalStrategy(profile);

    // Notify listeners
    this.notifyListeners();
  }

  /**
   * Get optimal connection strategy for network profile
   */
  public getOptimalStrategy(profile: NetworkProfile): ConnectionStrategy {
    // Generate strategy key
    const key = `${profile.type}-${profile.quality}`;
    let strategy = NETWORK_STRATEGIES[key];

    // Fallback strategies
    if (!strategy) {
      if (profile.type === 'unknown') {
        strategy = NETWORK_STRATEGIES['unknown-default'];
      } else {
        // Try with 'good' quality as fallback
        const fallbackKey = `${profile.type}-good`;
        strategy = NETWORK_STRATEGIES[fallbackKey] || NETWORK_STRATEGIES['unknown-default'];
      }
    }

    // Apply stability adjustments
    strategy = this.adjustStrategyForStability(strategy, profile);

    // Apply cellular generation optimizations
    if (profile.type === 'cellular' && profile.generation) {
      strategy = this.adjustStrategyForCellularGeneration(strategy, profile.generation);
    }

    return strategy;
  }

  /**
   * Adjust strategy based on network stability
   */
  private adjustStrategyForStability(
    strategy: ConnectionStrategy,
    profile: NetworkProfile
  ): ConnectionStrategy {
    const adjusted = JSON.parse(JSON.stringify(strategy)) as ConnectionStrategy;

    if (profile.stability < 0.5) {
      // Very unstable network - be more aggressive
      adjusted.timeouts.connection = Math.max(adjusted.timeouts.connection * 1.3, 15000);
      adjusted.retryPolicy.maxAttempts = Math.min(adjusted.retryPolicy.maxAttempts + 2, 8);
      adjusted.retryPolicy.backoffMultiplier = Math.min(adjusted.retryPolicy.backoffMultiplier * 1.2, 3.0);
      adjusted.heartbeatProfile = 'aggressive';
    } else if (profile.stability > 0.9) {
      // Very stable network - be more efficient
      adjusted.timeouts.connection = Math.max(adjusted.timeouts.connection * 0.8, 5000);
      adjusted.timeouts.heartbeat = Math.min(adjusted.timeouts.heartbeat * 1.2, 40000);
    }

    return adjusted;
  }

  /**
   * Adjust strategy for cellular generation
   */
  private adjustStrategyForCellularGeneration(
    strategy: ConnectionStrategy,
    generation: string
  ): ConnectionStrategy {
    const adjusted = JSON.parse(JSON.stringify(strategy)) as ConnectionStrategy;

    switch (generation) {
      case '3g':
        // 3G networks are typically slower and less reliable
        adjusted.timeouts.connection = Math.max(adjusted.timeouts.connection * 1.5, 20000);
        adjusted.timeouts.heartbeat = Math.max(adjusted.timeouts.heartbeat * 0.8, 15000);
        adjusted.retryPolicy.maxAttempts = Math.min(adjusted.retryPolicy.maxAttempts + 1, 7);
        adjusted.heartbeatProfile = 'aggressive';
        break;

      case '4g':
        // 4G is generally reliable, use standard adjustments
        break;

      case '5g':
        // 5G networks are typically fast and reliable
        adjusted.timeouts.connection = Math.max(adjusted.timeouts.connection * 0.8, 6000);
        adjusted.timeouts.heartbeat = Math.min(adjusted.timeouts.heartbeat * 1.1, 35000);
        break;
    }

    return adjusted;
  }

  /**
   * Notify all listeners of profile/strategy changes
   */
  private notifyListeners(): void {
    if (!this.currentProfile || !this.currentStrategy) return;

    this.listeners.forEach(listener => {
      try {
        listener(this.currentProfile!, this.currentStrategy!);
      } catch (error) {
        console.error('🌐 NetworkDetection: Error in listener:', error);
      }
    });
  }

  /**
   * Get network detection statistics
   */
  getStatistics(): NetworkDetectionStatistics {
    return {
      totalTests: this.latencyHistory.length,
      successRate: this.latencyHistory.length > 0
        ? this.latencyHistory.filter(r => r.success).length / this.latencyHistory.length
        : 0,
      averageLatency: this.latencyHistory.length > 0
        ? this.latencyHistory
            .filter(r => r.success && r.latency !== null)
            .reduce((sum, r) => sum + r.latency!, 0) /
          this.latencyHistory.filter(r => r.success && r.latency !== null).length
        : null,
      currentStability: this.calculateStability(),
      strategyChanges: 0, // Could track this if needed
      lastProfileUpdate: this.currentProfile ? Date.now() : null
    };
  }
}

/**
 * Interface for network detection statistics
 */
export interface NetworkDetectionStatistics {
  totalTests: number;
  successRate: number;
  averageLatency: number | null;
  currentStability: number;
  strategyChanges: number;
  lastProfileUpdate: number | null;
}

// Global singleton instance
export const networkDetection = new NetworkDetection();

/**
 * Convenience function to start network detection
 */
export function startNetworkDetection(): void {
  networkDetection.start();
}

/**
 * Convenience function to stop network detection
 */
export function stopNetworkDetection(): void {
  networkDetection.stop();
}

/**
 * Get current network profile
 */
export function getCurrentNetworkProfile(): NetworkProfile | null {
  return networkDetection.getCurrentProfile();
}

/**
 * Get current connection strategy
 */
export function getCurrentConnectionStrategy(): ConnectionStrategy | null {
  return networkDetection.getCurrentStrategy();
}