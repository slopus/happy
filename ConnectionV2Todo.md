# Happy Coder Connection Logic V2 - AI Action Items TODO List

## Overview
This document contains actionable tasks for implementing the Connection Logic V2 enhancements. Each task includes implementation details, test plans, quality assurance measures, and success criteria designed for AI autonomous development.

---

## PHASE 1: QUICK WINS (Priority: HIGH)

### Task 1.1: Enable Socket.IO Transport Fallbacks
**File**: `sources/sync/apiSocket.ts`
**Status**: 🔄 Ready to Implement
**Estimated AI Effort**: 15-20 minutes
**Dependencies**: None

#### Implementation Details
```typescript
// Current configuration
const socket = io(endpoint, {
  transports: ['websocket'],
  path: '/v1/updates',
  // ... existing config
});

// Target configuration
const socket = io(endpoint, {
  transports: ['websocket', 'polling'], // ADD POLLING FALLBACK
  path: '/v1/updates',
  forceNew: true,
  upgrade: true, // Allow upgrade from polling to websocket
  rememberUpgrade: true, // Remember successful upgrades
  // ... existing config
});
```

#### Test Plan
1. **Unit Tests** (`__tests__/sync/apiSocket.test.ts`):
   ```typescript
   describe('Transport Fallback', () => {
     test('should attempt websocket first', async () => {
       // Mock websocket success
       // Verify websocket transport used
     });

     test('should fallback to polling when websocket fails', async () => {
       // Mock websocket failure
       // Verify polling transport used
       // Verify connection established
     });

     test('should upgrade from polling to websocket when available', async () => {
       // Start with polling
       // Enable websocket
       // Verify upgrade occurs
     });
   });
   ```

2. **Integration Tests**:
   - Test in environment with WebSocket blocked
   - Verify fallback to HTTP long-polling
   - Measure connection establishment time difference

3. **Manual Test Cases**:
   - Corporate firewall simulation
   - Proxy server environments
   - Network restrictions testing

#### Quality Assurance
- **Performance Impact**: Monitor connection time increase with polling
- **Battery Usage**: Measure battery impact of polling vs WebSocket
- **Reliability**: 99.5% connection success rate target
- **Compatibility**: Test on iOS/Android/Web platforms

#### Success Criteria
- [ ] WebSocket attempted first in all scenarios
- [ ] Automatic fallback to polling when WebSocket fails
- [ ] Upgrade to WebSocket when network allows
- [ ] No regression in connection reliability
- [ ] <2 second additional latency for polling fallback

---

### Task 1.2: Enable Enhanced Connection Management
**File**: `sources/sync/connectionConfig.ts`
**Status**: 🔄 Ready to Implement
**Estimated AI Effort**: 5-10 minutes
**Dependencies**: Existing enhanced management code

#### Implementation Details
```typescript
// Current configuration
export const CONNECTION_CONFIG = {
  enableEnhancedConnectionManagement: false, // CHANGE TO TRUE
  maxReconnectAttempts: 5,
  heartbeatInterval: 30000,
  // ... other config
};

// Also update any feature flags or conditional logic
```

#### Verification Steps
1. **Locate all references** to `enableEnhancedConnectionManagement`
2. **Review enhanced features** that will be activated
3. **Update configuration** and test impact
4. **Verify backward compatibility** maintained

#### Test Plan
1. **Unit Tests** (`__tests__/sync/connectionConfig.test.ts`):
   ```typescript
   describe('Enhanced Connection Management', () => {
     test('should enable enhanced features by default', () => {
       expect(CONNECTION_CONFIG.enableEnhancedConnectionManagement).toBe(true);
     });

     test('should maintain backward compatibility', () => {
       // Test with enhanced features disabled
       // Verify basic functionality works
     });
   });
   ```

2. **Integration Tests**:
   - Compare connection behavior before/after enablement
   - Verify enhanced retry logic activates
   - Test improved error recovery

#### Quality Assurance
- **Regression Testing**: Ensure existing functionality unaffected
- **Performance Monitoring**: Track connection metrics
- **Error Handling**: Verify enhanced error recovery works

#### Success Criteria
- [ ] Enhanced management enabled by default
- [ ] All existing tests pass
- [ ] Enhanced features activate correctly
- [ ] No performance degradation
- [ ] Improved error recovery demonstrated

---

### Task 1.3: Implement Aggressive Heartbeat Profiles
**File**: `sources/sync/connectionHealth.ts`
**Status**: 🔄 Ready to Implement
**Estimated AI Effort**: 45-60 minutes
**Dependencies**: Task 1.2 completion

#### Implementation Details
```typescript
// Add heartbeat profiles configuration
export interface HeartbeatProfile {
  interval: number;
  timeout: number;
  maxConsecutiveFailures: number;
  description: string;
}

export const HEARTBEAT_PROFILES: Record<string, HeartbeatProfile> = {
  standard: {
    interval: 30000,
    timeout: 10000,
    maxConsecutiveFailures: 3,
    description: 'Default profile for stable networks'
  },
  aggressive: {
    interval: 15000,
    timeout: 5000,
    maxConsecutiveFailures: 2,
    description: 'Faster detection for unstable networks'
  },
  corporate: {
    interval: 10000,
    timeout: 3000,
    maxConsecutiveFailures: 1,
    description: 'Aggressive profile for strict firewalls'
  },
  battery_saver: {
    interval: 60000,
    timeout: 15000,
    maxConsecutiveFailures: 5,
    description: 'Reduced frequency for battery conservation'
  }
};

// Update ConnectionHealth class
export class ConnectionHealth {
  private currentProfile: HeartbeatProfile;

  setProfile(profileName: keyof typeof HEARTBEAT_PROFILES) {
    this.currentProfile = HEARTBEAT_PROFILES[profileName];
    this.reconfigureHeartbeat();
  }

  private reconfigureHeartbeat() {
    // Update ping intervals and timeouts
    // Restart heartbeat with new settings
  }

  autoDetectProfile(): keyof typeof HEARTBEAT_PROFILES {
    // Logic to detect optimal profile based on:
    // - Connection failure patterns
    // - Network type detection
    // - Battery level
    return 'standard';
  }
}
```

#### Test Plan
1. **Unit Tests** (`__tests__/sync/connectionHealth.test.ts`):
   ```typescript
   describe('Heartbeat Profiles', () => {
     test('should apply profile settings correctly', () => {
       const health = new ConnectionHealth();
       health.setProfile('aggressive');
       expect(health.currentProfile.interval).toBe(15000);
     });

     test('should auto-detect appropriate profile', () => {
       // Mock different network conditions
       // Verify correct profile selection
     });

     test('should reconfigure heartbeat when profile changes', () => {
       // Test heartbeat interval changes
       // Verify ping frequency updates
     });
   });
   ```

2. **Performance Tests**:
   ```typescript
   describe('Heartbeat Performance', () => {
     test('aggressive profile should detect failures faster', async () => {
       // Compare failure detection time between profiles
     });

     test('battery saver should reduce ping frequency', () => {
       // Monitor ping count over time period
     });
   });
   ```

3. **Network Simulation Tests**:
   - Simulate firewall timeout scenarios
   - Test different network latency conditions
   - Verify profile effectiveness

#### Quality Assurance
- **Battery Impact**: Measure battery usage for each profile
- **Network Efficiency**: Monitor data usage per profile
- **Detection Speed**: Verify faster failure detection in aggressive modes
- **Stability**: Ensure profiles don't cause connection instability

#### Success Criteria
- [ ] All profiles implemented and configurable
- [ ] Auto-detection logic selects appropriate profiles
- [ ] Aggressive profile detects failures 50% faster
- [ ] Battery saver profile reduces ping frequency by 50%
- [ ] No false positive disconnections

---

### Task 1.4: Network-Aware Connection Strategies
**File**: `sources/sync/networkDetection.ts` (NEW)
**Status**: 🔄 Ready to Implement
**Estimated AI Effort**: 2-3 hours
**Dependencies**: Task 1.3 completion

#### Implementation Details
```typescript
// Create new network detection module
import NetInfo from '@react-native-community/netinfo';

export interface NetworkProfile {
  type: 'wifi' | 'cellular' | 'ethernet' | 'unknown';
  quality: 'excellent' | 'good' | 'poor' | 'unknown';
  stability: number; // 0-1 score based on recent history
  strength: number | null; // Signal strength where available
  isExpensive: boolean; // Cellular data cost consideration
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
  heartbeatProfile: keyof typeof HEARTBEAT_PROFILES;
}

export const NETWORK_STRATEGIES: Record<string, ConnectionStrategy> = {
  'wifi-excellent': {
    timeouts: { connection: 8000, heartbeat: 30000, retry: 1000 },
    retryPolicy: { maxAttempts: 3, backoffMultiplier: 1.5, baseDelay: 500 },
    heartbeatProfile: 'standard'
  },
  'wifi-poor': {
    timeouts: { connection: 15000, heartbeat: 15000, retry: 2000 },
    retryPolicy: { maxAttempts: 5, backoffMultiplier: 2.0, baseDelay: 1000 },
    heartbeatProfile: 'aggressive'
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
  'corporate-restricted': {
    timeouts: { connection: 10000, heartbeat: 8000, retry: 1500 },
    retryPolicy: { maxAttempts: 8, backoffMultiplier: 1.2, baseDelay: 800 },
    heartbeatProfile: 'corporate'
  }
};

export class NetworkDetection {
  private currentProfile: NetworkProfile | null = null;
  private qualityHistory: number[] = [];
  private stabilityScore: number = 1.0;

  async detectNetworkProfile(): Promise<NetworkProfile> {
    const netInfo = await NetInfo.fetch();

    return {
      type: this.mapNetworkType(netInfo.type),
      quality: await this.assessNetworkQuality(),
      stability: this.calculateStability(),
      strength: netInfo.details?.strength || null,
      isExpensive: netInfo.isInternetReachable &&
                   (netInfo.type === 'cellular')
    };
  }

  private async assessNetworkQuality(): Promise<NetworkProfile['quality']> {
    // Perform latency tests to assess quality
    const latencyTests = await Promise.allSettled([
      this.pingTest('https://api.happy.engineering/ping'),
      this.pingTest('https://1.1.1.1'), // Cloudflare DNS
      this.pingTest('https://8.8.8.8')  // Google DNS
    ]);

    const avgLatency = this.calculateAverageLatency(latencyTests);

    if (avgLatency < 100) return 'excellent';
    if (avgLatency < 300) return 'good';
    if (avgLatency < 800) return 'poor';
    return 'unknown';
  }

  getOptimalStrategy(profile: NetworkProfile): ConnectionStrategy {
    const key = `${profile.type}-${profile.quality}`;
    return NETWORK_STRATEGIES[key] || NETWORK_STRATEGIES['wifi-good'];
  }
}
```

#### Test Plan
1. **Unit Tests** (`__tests__/sync/networkDetection.test.ts`):
   ```typescript
   describe('Network Detection', () => {
     test('should detect network type correctly', async () => {
       // Mock NetInfo responses
       // Verify correct type detection
     });

     test('should assess network quality accurately', async () => {
       // Mock latency test responses
       // Verify quality assessment
     });

     test('should select appropriate strategy', () => {
       // Test strategy selection for different profiles
     });

     test('should track network stability over time', () => {
       // Test stability scoring algorithm
     });
   });
   ```

2. **Integration Tests**:
   ```typescript
   describe('Network Strategy Integration', () => {
     test('should apply strategy to connection manager', () => {
       // Verify strategy application
     });

     test('should adapt to network changes', () => {
       // Simulate network type changes
       // Verify strategy updates
     });
   });
   ```

3. **Performance Tests**:
   - Measure strategy effectiveness for different network types
   - Verify reduced timeouts don't cause false failures
   - Test battery impact of network monitoring

#### Quality Assurance
- **Accuracy**: Network detection accuracy >95%
- **Performance**: Strategy changes within 5 seconds of network change
- **Battery**: Network monitoring <2% battery impact
- **Reliability**: No increase in false disconnections

#### Success Criteria
- [ ] Accurate network type and quality detection
- [ ] Appropriate strategy selection for each network profile
- [ ] Automatic adaptation to network changes
- [ ] Improved connection success rate on poor networks
- [ ] Maintained performance on good networks

---

## PHASE 2: MOBILE OPTIMIZATIONS (Priority: MEDIUM)

### Task 2.1: Background Task Registration
**File**: `sources/sync/backgroundSync.ts` (NEW)
**Status**: 🔄 Ready to Implement
**Estimated AI Effort**: 3-4 hours
**Dependencies**: Phase 1 completion

#### Implementation Details
```typescript
import BackgroundJob from 'react-native-background-job';
import { AppState, AppStateStatus } from 'react-native';

export interface BackgroundSyncConfig {
  maxBackgroundTime: number; // milliseconds
  criticalOperations: string[];
  syncInterval: number;
}

export class BackgroundSyncManager {
  private isBackgroundTaskActive: boolean = false;
  private backgroundTaskId: string | null = null;
  private appStateSubscription: any = null;

  constructor(private config: BackgroundSyncConfig) {
    this.setupAppStateListener();
  }

  private setupAppStateListener() {
    this.appStateSubscription = AppState.addEventListener(
      'change',
      this.handleAppStateChange.bind(this)
    );
  }

  private async handleAppStateChange(nextAppState: AppStateStatus) {
    if (nextAppState === 'background' || nextAppState === 'inactive') {
      await this.startBackgroundSync();
    } else if (nextAppState === 'active') {
      await this.stopBackgroundSync();
      await this.refreshAllSyncServices();
    }
  }

  private async startBackgroundSync() {
    if (this.isBackgroundTaskActive) return;

    try {
      // Register background task
      this.backgroundTaskId = await BackgroundJob.register({
        jobKey: 'happy-connection-maintenance',
        period: this.config.syncInterval,
      });

      this.isBackgroundTaskActive = true;

      // Start background execution
      await BackgroundJob.start({
        jobKey: 'happy-connection-maintenance',
        job: this.backgroundSyncJob.bind(this),
      });

      console.log('Background sync started');
    } catch (error) {
      console.error('Failed to start background sync:', error);
    }
  }

  private async backgroundSyncJob() {
    try {
      // Maintain critical connections
      await this.maintainCriticalConnections();

      // Sync critical data
      await this.syncCriticalData();

      // Clean up stale connections
      await this.cleanupStaleConnections();

    } catch (error) {
      console.error('Background sync job failed:', error);
    }
  }

  private async maintainCriticalConnections() {
    // Send lightweight pings to maintain connections
    // Update connection health status
    // Handle reconnection if needed
  }

  private async syncCriticalData() {
    // Sync only critical data to minimize battery usage
    // Prioritize user actions and session state
  }

  private async stopBackgroundSync() {
    if (!this.isBackgroundTaskActive) return;

    try {
      if (this.backgroundTaskId) {
        await BackgroundJob.stop({ jobKey: 'happy-connection-maintenance' });
        await BackgroundJob.unregister({ jobKey: 'happy-connection-maintenance' });
        this.backgroundTaskId = null;
      }

      this.isBackgroundTaskActive = false;
      console.log('Background sync stopped');
    } catch (error) {
      console.error('Failed to stop background sync:', error);
    }
  }

  private async refreshAllSyncServices() {
    // Called when app becomes active
    // Refresh all sync services as currently done
    // Reconcile any changes that occurred during background
  }
}
```

#### Test Plan
1. **Unit Tests** (`__tests__/sync/backgroundSync.test.ts`):
   ```typescript
   describe('Background Sync Manager', () => {
     test('should start background task when app goes to background', async () => {
       // Mock AppState change to background
       // Verify background task registration
     });

     test('should maintain connections during background', async () => {
       // Test connection maintenance in background
     });

     test('should stop background task when app becomes active', async () => {
       // Mock AppState change to active
       // Verify background task cleanup
     });

     test('should handle background task failures gracefully', async () => {
       // Mock background task failures
       // Verify error handling
     });
   });
   ```

2. **Integration Tests**:
   - Test with real app state transitions
   - Verify connection persistence in background
   - Test battery usage impact

3. **Platform-Specific Tests**:
   - iOS background task limitations
   - Android doze mode compatibility
   - Web platform graceful degradation

#### Quality Assurance
- **Battery Impact**: <5% additional battery usage
- **Connection Persistence**: 80% connection survival in background
- **Data Usage**: Minimal data usage in background mode
- **Platform Compatibility**: Works on iOS/Android/Web

#### Success Criteria
- [ ] Background tasks register successfully
- [ ] Connections maintained longer in background
- [ ] Graceful handling of platform limitations
- [ ] No significant battery impact
- [ ] Improved user experience for background/foreground transitions

---

### Task 2.2: Adaptive Health Monitoring
**File**: `sources/sync/adaptiveHealth.ts` (NEW)
**Status**: 🔄 Ready to Implement
**Estimated AI Effort**: 2-3 hours
**Dependencies**: Task 1.3 completion

#### Implementation Details
```typescript
export interface AdaptiveHealthConfig {
  basePingInterval: number;
  minPingInterval: number;
  maxPingInterval: number;
  adaptationRate: number;
  stabilityThreshold: number;
}

export class AdaptiveHealthMonitor {
  private currentInterval: number;
  private consecutiveSuccesses: number = 0;
  private consecutiveFailures: number = 0;
  private pingHistory: PingResult[] = [];
  private adaptationTimer: NodeJS.Timeout | null = null;

  constructor(private config: AdaptiveHealthConfig) {
    this.currentInterval = config.basePingInterval;
  }

  recordPingResult(result: PingResult) {
    this.pingHistory.push(result);

    // Keep only recent history
    if (this.pingHistory.length > 20) {
      this.pingHistory.shift();
    }

    if (result.success) {
      this.consecutiveSuccesses++;
      this.consecutiveFailures = 0;
    } else {
      this.consecutiveFailures++;
      this.consecutiveSuccesses = 0;
    }

    this.scheduleAdaptation();
  }

  private scheduleAdaptation() {
    if (this.adaptationTimer) {
      clearTimeout(this.adaptationTimer);
    }

    this.adaptationTimer = setTimeout(() => {
      this.adaptPingInterval();
    }, 5000); // Adapt after 5 seconds of stable results
  }

  private adaptPingInterval() {
    const stability = this.calculateStability();
    const latencyTrend = this.calculateLatencyTrend();

    if (this.consecutiveFailures >= 2 || stability < 0.7) {
      // Increase frequency during instability
      this.currentInterval = Math.max(
        this.config.minPingInterval,
        this.currentInterval * 0.7
      );
    } else if (this.consecutiveSuccesses >= 5 && stability > 0.9) {
      // Decrease frequency during stable periods
      this.currentInterval = Math.min(
        this.config.maxPingInterval,
        this.currentInterval * 1.3
      );
    }

    // Apply latency-based adjustments
    if (latencyTrend > 1.5) {
      // Latency increasing, check more frequently
      this.currentInterval *= 0.8;
    }

    this.currentInterval = Math.max(
      this.config.minPingInterval,
      Math.min(this.config.maxPingInterval, this.currentInterval)
    );

    this.scheduleNextPing();
  }

  private calculateStability(): number {
    if (this.pingHistory.length < 5) return 1.0;

    const recentResults = this.pingHistory.slice(-10);
    const successRate = recentResults.filter(r => r.success).length / recentResults.length;

    // Factor in latency variance
    const latencies = recentResults
      .filter(r => r.success && r.latency !== undefined)
      .map(r => r.latency!);

    if (latencies.length < 3) return successRate;

    const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const variance = latencies.reduce((acc, lat) =>
      acc + Math.pow(lat - avgLatency, 2), 0) / latencies.length;

    const latencyStability = Math.max(0, 1 - (variance / (avgLatency * avgLatency)));

    return (successRate * 0.7) + (latencyStability * 0.3);
  }

  private calculateLatencyTrend(): number {
    if (this.pingHistory.length < 6) return 1.0;

    const recentLatencies = this.pingHistory
      .slice(-6)
      .filter(r => r.success && r.latency !== undefined)
      .map(r => r.latency!);

    if (recentLatencies.length < 4) return 1.0;

    const firstHalf = recentLatencies.slice(0, Math.floor(recentLatencies.length / 2));
    const secondHalf = recentLatencies.slice(Math.floor(recentLatencies.length / 2));

    const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
    const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

    return avgSecond / avgFirst;
  }

  getCurrentInterval(): number {
    return this.currentInterval;
  }

  private scheduleNextPing() {
    // Update the ping scheduler with new interval
    // This would integrate with existing ping mechanism
  }
}

interface PingResult {
  timestamp: number;
  success: boolean;
  latency?: number;
  error?: string;
}
```

#### Test Plan
1. **Unit Tests** (`__tests__/sync/adaptiveHealth.test.ts`):
   ```typescript
   describe('Adaptive Health Monitor', () => {
     test('should increase ping frequency during failures', () => {
       const monitor = new AdaptiveHealthMonitor(defaultConfig);

       // Simulate consecutive failures
       for (let i = 0; i < 3; i++) {
         monitor.recordPingResult({
           timestamp: Date.now(),
           success: false
         });
       }

       expect(monitor.getCurrentInterval()).toBeLessThan(defaultConfig.basePingInterval);
     });

     test('should decrease ping frequency during stability', () => {
       const monitor = new AdaptiveHealthMonitor(defaultConfig);

       // Simulate consecutive successes
       for (let i = 0; i < 6; i++) {
         monitor.recordPingResult({
           timestamp: Date.now(),
           success: true,
           latency: 50
         });
       }

       expect(monitor.getCurrentInterval()).toBeGreaterThan(defaultConfig.basePingInterval);
     });

     test('should respond to latency trends', () => {
       // Test latency-based adaptations
     });

     test('should respect min/max interval bounds', () => {
       // Test boundary conditions
     });
   });
   ```

2. **Simulation Tests**:
   ```typescript
   describe('Network Condition Simulation', () => {
     test('should adapt to unstable network conditions', () => {
       // Simulate intermittent connectivity
     });

     test('should optimize for stable network conditions', () => {
       // Simulate stable, good connectivity
     });
   });
   ```

#### Quality Assurance
- **Responsiveness**: Adaptation occurs within 10 seconds of condition change
- **Stability**: No oscillation between adaptation states
- **Efficiency**: Reduced ping frequency during stable periods
- **Accuracy**: Failure detection speed improves during unstable periods

#### Success Criteria
- [ ] Ping frequency adapts to network conditions
- [ ] Faster failure detection during unstable periods
- [ ] Reduced battery usage during stable periods
- [ ] No false positive disconnections
- [ ] Smooth adaptation without oscillation

---

### Task 2.3: Enhanced Session Recovery
**File**: `sources/sync/enhancedRecovery.ts` (NEW)
**Status**: 🔄 Ready to Implement
**Estimated AI Effort**: 4-5 hours
**Dependencies**: Task 2.1 completion

#### Implementation Details
```typescript
export interface QueuedOperation {
  id: string;
  type: 'message' | 'state_update' | 'user_action';
  data: any;
  timestamp: number;
  priority: 'low' | 'medium' | 'high' | 'critical';
  retryCount: number;
  maxRetries: number;
  expiresAt: number;
}

export interface ConflictResolution {
  strategy: 'local_wins' | 'remote_wins' | 'merge' | 'user_choice';
  mergeFunction?: (local: any, remote: any) => any;
}

export class EnhancedSessionRecovery {
  private offlineQueue: QueuedOperation[] = [];
  private conflictResolver: Map<string, ConflictResolution> = new Map();
  private maxQueueSize: number = 1000;
  private maxOfflineTime: number = 24 * 60 * 60 * 1000; // 24 hours

  constructor() {
    this.setupConflictResolvers();
    this.startQueueMaintenance();
  }

  queueOperation(operation: Omit<QueuedOperation, 'id' | 'retryCount'>): string {
    const id = this.generateOperationId();
    const queuedOp: QueuedOperation = {
      ...operation,
      id,
      retryCount: 0,
    };

    // Insert based on priority
    this.insertByPriority(queuedOp);

    // Enforce queue size limits
    this.enforceQueueLimits();

    return id;
  }

  private insertByPriority(operation: QueuedOperation) {
    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    const insertIndex = this.offlineQueue.findIndex(
      op => priorityOrder[op.priority] > priorityOrder[operation.priority]
    );

    if (insertIndex === -1) {
      this.offlineQueue.push(operation);
    } else {
      this.offlineQueue.splice(insertIndex, 0, operation);
    }
  }

  private enforceQueueLimits() {
    // Remove expired operations
    const now = Date.now();
    this.offlineQueue = this.offlineQueue.filter(op => op.expiresAt > now);

    // Enforce size limits (remove oldest low-priority items)
    if (this.offlineQueue.length > this.maxQueueSize) {
      const lowPriorityItems = this.offlineQueue
        .filter(op => op.priority === 'low')
        .sort((a, b) => a.timestamp - b.timestamp);

      const toRemove = this.offlineQueue.length - this.maxQueueSize;
      lowPriorityItems.slice(0, toRemove).forEach(op => {
        const index = this.offlineQueue.indexOf(op);
        if (index > -1) this.offlineQueue.splice(index, 1);
      });
    }
  }

  async processOfflineQueue(): Promise<ProcessingResult> {
    const results: ProcessingResult = {
      processed: 0,
      failed: 0,
      conflicts: 0,
      errors: []
    };

    // Process operations in priority order
    for (const operation of [...this.offlineQueue]) {
      try {
        const result = await this.processOperation(operation);

        if (result.success) {
          this.removeFromQueue(operation.id);
          results.processed++;
        } else if (result.conflict) {
          results.conflicts++;
          await this.handleConflict(operation, result.conflictData);
        } else {
          operation.retryCount++;
          if (operation.retryCount >= operation.maxRetries) {
            this.removeFromQueue(operation.id);
            results.failed++;
            results.errors.push({
              operationId: operation.id,
              error: result.error || 'Max retries exceeded'
            });
          }
        }
      } catch (error) {
        results.errors.push({
          operationId: operation.id,
          error: error.message
        });
      }
    }

    return results;
  }

  private async processOperation(operation: QueuedOperation): Promise<OperationResult> {
    switch (operation.type) {
      case 'message':
        return await this.processMessage(operation);
      case 'state_update':
        return await this.processStateUpdate(operation);
      case 'user_action':
        return await this.processUserAction(operation);
      default:
        throw new Error(`Unknown operation type: ${operation.type}`);
    }
  }

  private async handleConflict(
    operation: QueuedOperation,
    conflictData: any
  ): Promise<void> {
    const resolver = this.conflictResolver.get(operation.type);
    if (!resolver) {
      // Default to merge strategy
      return this.mergeConflict(operation, conflictData);
    }

    switch (resolver.strategy) {
      case 'local_wins':
        // Keep local version, discard remote
        await this.forceLocalUpdate(operation);
        break;
      case 'remote_wins':
        // Discard local, accept remote
        this.removeFromQueue(operation.id);
        break;
      case 'merge':
        if (resolver.mergeFunction) {
          const merged = resolver.mergeFunction(operation.data, conflictData);
          operation.data = merged;
          await this.processOperation(operation);
        }
        break;
      case 'user_choice':
        // Present conflict to user for resolution
        await this.presentConflictToUser(operation, conflictData);
        break;
    }
  }

  private setupConflictResolvers() {
    // Message conflicts: timestamp-based resolution
    this.conflictResolver.set('message', {
      strategy: 'merge',
      mergeFunction: (local, remote) => {
        return local.timestamp > remote.timestamp ? local : remote;
      }
    });

    // State updates: field-level merging
    this.conflictResolver.set('state_update', {
      strategy: 'merge',
      mergeFunction: (local, remote) => {
        return this.mergeStateUpdates(local, remote);
      }
    });

    // User actions: local wins (user intent preservation)
    this.conflictResolver.set('user_action', {
      strategy: 'local_wins'
    });
  }

  private mergeStateUpdates(local: any, remote: any): any {
    // Implement field-level merging logic
    // Compare timestamps and version numbers
    // Preserve user modifications
    const merged = { ...remote };

    Object.keys(local).forEach(key => {
      if (local[key]?.lastModified > remote[key]?.lastModified) {
        merged[key] = local[key];
      }
    });

    return merged;
  }

  getQueueStatus(): QueueStatus {
    const now = Date.now();
    const byPriority = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0
    };

    let oldestOperation = now;
    this.offlineQueue.forEach(op => {
      byPriority[op.priority]++;
      if (op.timestamp < oldestOperation) {
        oldestOperation = op.timestamp;
      }
    });

    return {
      totalOperations: this.offlineQueue.length,
      byPriority,
      oldestOperationAge: now - oldestOperation,
      estimatedProcessingTime: this.estimateProcessingTime()
    };
  }
}

interface ProcessingResult {
  processed: number;
  failed: number;
  conflicts: number;
  errors: Array<{ operationId: string; error: string }>;
}

interface OperationResult {
  success: boolean;
  conflict?: boolean;
  conflictData?: any;
  error?: string;
}

interface QueueStatus {
  totalOperations: number;
  byPriority: Record<string, number>;
  oldestOperationAge: number;
  estimatedProcessingTime: number;
}
```

#### Test Plan
1. **Unit Tests** (`__tests__/sync/enhancedRecovery.test.ts`):
   ```typescript
   describe('Enhanced Session Recovery', () => {
     test('should queue operations by priority', () => {
       const recovery = new EnhancedSessionRecovery();

       recovery.queueOperation({
         type: 'message',
         data: { text: 'low priority' },
         priority: 'low',
         timestamp: Date.now(),
         maxRetries: 3,
         expiresAt: Date.now() + 60000
       });

       recovery.queueOperation({
         type: 'message',
         data: { text: 'critical' },
         priority: 'critical',
         timestamp: Date.now(),
         maxRetries: 5,
         expiresAt: Date.now() + 60000
       });

       const status = recovery.getQueueStatus();
       expect(status.byPriority.critical).toBe(1);
       expect(status.byPriority.low).toBe(1);
     });

     test('should process operations in priority order', async () => {
       // Test processing order
     });

     test('should handle conflicts appropriately', async () => {
       // Test conflict resolution strategies
     });

     test('should enforce queue size limits', () => {
       // Test queue size management
     });

     test('should remove expired operations', () => {
       // Test expiration cleanup
     });
   });
   ```

2. **Integration Tests**:
   ```typescript
   describe('Session Recovery Integration', () => {
     test('should recover from extended offline period', async () => {
       // Simulate extended offline period with queued operations
       // Verify successful recovery and processing
     });

     test('should handle complex conflict scenarios', async () => {
       // Test realistic conflict scenarios
     });
   });
   ```

3. **Stress Tests**:
   ```typescript
   describe('Recovery Stress Tests', () => {
     test('should handle large queue efficiently', async () => {
       // Test with 1000+ queued operations
     });

     test('should maintain performance under load', async () => {
       // Performance benchmarks
     });
   });
   ```

#### Quality Assurance
- **Data Integrity**: No data loss during conflicts
- **Performance**: Queue processing <5 seconds for 100 operations
- **Memory Usage**: Queue memory usage <10MB for 1000 operations
- **Reliability**: 99.9% successful operation recovery

#### Success Criteria
- [ ] Operations queued and processed by priority
- [ ] Conflicts resolved without data loss
- [ ] Queue limits enforced efficiently
- [ ] Extended offline periods handled gracefully
- [ ] Performance maintained under load

---

## PHASE 3: INTELLIGENCE LAYER (Priority: LOW)

### Task 3.1: Connection Analytics and Learning
**File**: `sources/sync/connectionAnalytics.ts` (NEW)
**Status**: 🔄 Ready to Implement
**Estimated AI Effort**: 6-8 hours
**Dependencies**: Phase 2 completion

#### Implementation Details
```typescript
export interface ConnectionMetrics {
  networkType: string;
  avgLatency: number;
  successRate: number;
  failurePatterns: FailurePattern[];
  optimalHeartbeat: number;
  reconnectSuccessRate: number;
  dataUsage: number;
  batteryImpact: number;
  timeOfDay: number;
  location?: string;
}

export interface FailurePattern {
  type: 'timeout' | 'network_error' | 'server_error';
  frequency: number;
  timePattern: string; // e.g., "morning", "evening", "weekend"
  context: string; // e.g., "during_background", "network_switch"
}

export class ConnectionAnalytics {
  private metrics: Map<string, ConnectionMetrics> = new Map();
  private learningModel: SimpleMLModel;
  private readonly LEARNING_THRESHOLD = 10; // Minimum samples for learning

  constructor() {
    this.learningModel = new SimpleMLModel();
    this.loadStoredMetrics();
  }

  recordConnectionEvent(event: ConnectionEvent) {
    const key = this.generateMetricsKey(event.networkProfile);
    const existing = this.metrics.get(key) || this.createEmptyMetrics(event.networkProfile);

    this.updateMetrics(existing, event);
    this.metrics.set(key, existing);

    // Trigger learning if we have enough data
    if (this.getTotalSamples() >= this.LEARNING_THRESHOLD) {
      this.updateLearningModel();
    }

    this.persistMetrics();
  }

  private updateMetrics(metrics: ConnectionMetrics, event: ConnectionEvent) {
    // Update rolling averages
    metrics.avgLatency = this.updateRollingAverage(
      metrics.avgLatency,
      event.latency || 0,
      0.1
    );

    metrics.successRate = this.updateRollingAverage(
      metrics.successRate,
      event.success ? 1 : 0,
      0.05
    );

    // Track failure patterns
    if (!event.success && event.failureType) {
      this.updateFailurePattern(metrics, event);
    }

    // Update optimal settings based on performance
    if (event.success && event.heartbeatInterval) {
      metrics.optimalHeartbeat = this.calculateOptimalHeartbeat(
        metrics,
        event.heartbeatInterval,
        event.latency || 0
      );
    }
  }

  private updateFailurePattern(metrics: ConnectionMetrics, event: ConnectionEvent) {
    const timeContext = this.getTimeContext();
    const existingPattern = metrics.failurePatterns.find(
      p => p.type === event.failureType && p.timePattern === timeContext
    );

    if (existingPattern) {
      existingPattern.frequency++;
    } else {
      metrics.failurePatterns.push({
        type: event.failureType!,
        frequency: 1,
        timePattern: timeContext,
        context: event.context || 'unknown'
      });
    }

    // Keep only top 10 failure patterns
    metrics.failurePatterns.sort((a, b) => b.frequency - a.frequency);
    metrics.failurePatterns = metrics.failurePatterns.slice(0, 10);
  }

  getOptimalSettings(networkProfile: NetworkProfile): OptimalSettings {
    const key = this.generateMetricsKey(networkProfile);
    const metrics = this.metrics.get(key);

    if (!metrics || this.getTotalSamples() < this.LEARNING_THRESHOLD) {
      return this.getDefaultSettings(networkProfile);
    }

    // Use learned optimal settings
    return {
      heartbeatInterval: metrics.optimalHeartbeat,
      connectionTimeout: this.calculateOptimalTimeout(metrics),
      retryStrategy: this.calculateOptimalRetryStrategy(metrics),
      transportPriority: this.calculateOptimalTransports(metrics)
    };
  }

  private calculateOptimalTimeout(metrics: ConnectionMetrics): number {
    // Base timeout on average latency + buffer
    const baseTimeout = metrics.avgLatency * 5; // 5x latency as base
    const reliabilityFactor = 1 + (1 - metrics.successRate); // More buffer for unreliable connections

    return Math.max(5000, Math.min(30000, baseTimeout * reliabilityFactor));
  }

  private calculateOptimalRetryStrategy(metrics: ConnectionMetrics): RetryStrategy {
    const baseDelay = metrics.avgLatency * 2;
    const maxRetries = metrics.successRate > 0.9 ? 3 :
                     metrics.successRate > 0.7 ? 5 : 7;

    return {
      maxRetries,
      baseDelay: Math.max(500, Math.min(5000, baseDelay)),
      backoffMultiplier: metrics.successRate > 0.8 ? 1.5 : 2.0,
      jitter: true
    };
  }

  generatePerformanceReport(): PerformanceReport {
    const totalSamples = this.getTotalSamples();
    const overallSuccessRate = this.calculateOverallSuccessRate();
    const recommendations = this.generateRecommendations();

    return {
      totalSamples,
      overallSuccessRate,
      networkBreakdown: this.getNetworkBreakdown(),
      commonFailures: this.getCommonFailures(),
      recommendations,
      generatedAt: Date.now()
    };
  }

  private generateRecommendations(): string[] {
    const recommendations: string[] = [];
    const overallSuccessRate = this.calculateOverallSuccessRate();

    if (overallSuccessRate < 0.9) {
      recommendations.push('Consider enabling aggressive heartbeat profile');
    }

    const cellularMetrics = Array.from(this.metrics.values())
      .find(m => m.networkType.includes('cellular'));

    if (cellularMetrics && cellularMetrics.successRate < 0.8) {
      recommendations.push('Cellular connection quality is poor - consider cellular-specific optimizations');
    }

    const failurePatterns = this.getCommonFailures();
    if (failurePatterns.some(f => f.type === 'timeout')) {
      recommendations.push('Frequent timeouts detected - consider increasing connection timeouts');
    }

    return recommendations;
  }
}

class SimpleMLModel {
  private weights: Map<string, number> = new Map();

  train(features: number[], target: number) {
    // Simple linear regression for optimal parameter prediction
    // Implementation would use basic gradient descent
  }

  predict(features: number[]): number {
    // Predict optimal settings based on network conditions
    return 0;
  }
}

interface ConnectionEvent {
  networkProfile: NetworkProfile;
  success: boolean;
  latency?: number;
  failureType?: 'timeout' | 'network_error' | 'server_error';
  context?: string;
  heartbeatInterval?: number;
  timestamp: number;
}

interface OptimalSettings {
  heartbeatInterval: number;
  connectionTimeout: number;
  retryStrategy: RetryStrategy;
  transportPriority: string[];
}

interface RetryStrategy {
  maxRetries: number;
  baseDelay: number;
  backoffMultiplier: number;
  jitter: boolean;
}

interface PerformanceReport {
  totalSamples: number;
  overallSuccessRate: number;
  networkBreakdown: Array<{ networkType: string; successRate: number; avgLatency: number }>;
  commonFailures: FailurePattern[];
  recommendations: string[];
  generatedAt: number;
}
```

#### Test Plan
1. **Unit Tests** (`__tests__/sync/connectionAnalytics.test.ts`):
   ```typescript
   describe('Connection Analytics', () => {
     test('should record and aggregate connection events', () => {
       const analytics = new ConnectionAnalytics();

       analytics.recordConnectionEvent({
         networkProfile: { type: 'wifi', quality: 'good' },
         success: true,
         latency: 100,
         timestamp: Date.now()
       });

       const report = analytics.generatePerformanceReport();
       expect(report.totalSamples).toBe(1);
     });

     test('should generate optimal settings based on learned data', () => {
       // Test learning and optimization
     });

     test('should identify failure patterns', () => {
       // Test failure pattern detection
     });

     test('should provide actionable recommendations', () => {
       // Test recommendation generation
     });
   });
   ```

2. **Machine Learning Tests**:
   ```typescript
   describe('Learning Algorithm', () => {
     test('should improve predictions with more data', () => {
       // Test learning effectiveness
     });

     test('should adapt to changing network conditions', () => {
       // Test adaptation capability
     });
   });
   ```

#### Quality Assurance
- **Learning Effectiveness**: 20% improvement in connection success after 100 samples
- **Prediction Accuracy**: 85% accuracy in optimal setting predictions
- **Performance**: Analytics processing <100ms per event
- **Storage**: Efficient data storage with automatic cleanup

#### Success Criteria
- [ ] Connection events recorded and analyzed
- [ ] Optimal settings improve over time
- [ ] Failure patterns identified accurately
- [ ] Actionable recommendations generated
- [ ] Performance impact minimal

---

## TESTING FRAMEWORK

### Automated Test Suite
**File**: `__tests__/integration/connectionV2.test.ts`
**Purpose**: Comprehensive integration testing for all V2 features

```typescript
describe('Connection Logic V2 Integration', () => {
  test('should maintain connection through network changes', async () => {
    // Test network switching scenarios
  });

  test('should recover from extended offline periods', async () => {
    // Test offline/online cycles
  });

  test('should adapt to different network conditions', async () => {
    // Test adaptive behavior
  });

  test('should handle background/foreground transitions', async () => {
    // Test mobile app state changes
  });
});
```

### Performance Testing
**File**: `__tests__/performance/connectionPerformance.test.ts`
**Purpose**: Validate performance requirements

```typescript
describe('Connection Performance', () => {
  test('should establish connection within time limits', async () => {
    // Measure connection establishment time
  });

  test('should maintain low battery usage', async () => {
    // Monitor battery impact
  });

  test('should handle high message throughput', async () => {
    // Test scalability
  });
});
```

### Manual Testing Checklist

#### Network Condition Testing
- [ ] Test on excellent WiFi (low latency, high bandwidth)
- [ ] Test on poor WiFi (high latency, packet loss)
- [ ] Test on good cellular (4G/5G)
- [ ] Test on poor cellular (3G, weak signal)
- [ ] Test network switching (WiFi ↔ Cellular)
- [ ] Test corporate firewall environments
- [ ] Test public WiFi with restrictions

#### Mobile Platform Testing
- [ ] Test app backgrounding on iOS
- [ ] Test app backgrounding on Android
- [ ] Test device sleep/wake cycles
- [ ] Test low battery conditions
- [ ] Test airplane mode on/off
- [ ] Test phone calls interrupting connection

#### Reliability Testing
- [ ] Test 24-hour continuous connection
- [ ] Test connection during system updates
- [ ] Test rapid network quality changes
- [ ] Test server maintenance scenarios
- [ ] Test multiple device connections

## QUALITY ASSURANCE METRICS

### Connection Reliability
- **Target**: 99.5% connection success rate
- **Measurement**: Successful connections / Total connection attempts
- **Monitoring**: Real-time dashboard with alerts

### Performance Benchmarks
- **Connection Time**: <5 seconds average establishment
- **Reconnection Time**: <3 seconds average after network change
- **Battery Impact**: <3% additional usage over baseline
- **Memory Usage**: <50MB additional for all V2 features

### User Experience Metrics
- **Session Recovery**: 99% of user data preserved during network issues
- **Background Persistence**: 80% of connections survive app backgrounding
- **False Disconnections**: <1% false positive rate

## ROLLOUT STRATEGY

### Phase 1 Rollout (Quick Wins)
1. **Internal Testing**: Enable on development builds
2. **Beta Users**: 10% of beta users get V2 features
3. **Gradual Rollout**: Increase to 50% of users
4. **Full Deployment**: 100% after 1 week of stable metrics

### Phase 2 Rollout (Mobile Optimizations)
1. **Feature Flags**: Individual feature enablement
2. **A/B Testing**: Compare V1 vs V2 performance
3. **Platform-Specific**: iOS first, then Android
4. **Monitoring**: Enhanced monitoring during rollout

### Rollback Plan
- **Automatic Rollback**: If error rate >1% or crash rate >0.1%
- **Manual Rollback**: Via feature flags within 5 minutes
- **Data Preservation**: All user data maintained during rollback

---

## COMPLETION CHECKLIST

### Phase 1 Tasks (Total AI Time: ~4 hours)
- [ ] Task 1.1: Socket.IO Transport Fallbacks (15-20 minutes)
- [ ] Task 1.2: Enhanced Connection Management (5-10 minutes)
- [ ] Task 1.3: Aggressive Heartbeat Profiles (45-60 minutes)
- [ ] Task 1.4: Network-Aware Strategies (2-3 hours)
- [ ] All Phase 1 tests pass
- [ ] Performance benchmarks met
- [ ] Documentation updated

### Phase 2 Tasks (Total AI Time: ~10 hours)
- [ ] Task 2.1: Background Task Registration (3-4 hours)
- [ ] Task 2.2: Adaptive Health Monitoring (2-3 hours)
- [ ] Task 2.3: Enhanced Session Recovery (4-5 hours)
- [ ] All Phase 2 tests pass
- [ ] Mobile platform validation
- [ ] Battery usage within limits

### Phase 3 Tasks (Total AI Time: ~8 hours)
- [ ] Task 3.1: Connection Analytics (6-8 hours)
- [ ] Machine learning validation
- [ ] Performance optimization
- [ ] Final integration testing

### Documentation & Training
- [ ] Updated architecture documentation
- [ ] API documentation for new features
- [ ] Troubleshooting guides
- [ ] Team training materials
- [ ] User-facing feature documentation

---

**Document Version**: 1.0 (AI-Optimized)
**Last Updated**: 2025-09-17
**Estimated Total AI Effort**: ~22 hours
**Target Completion**: 3-5 days with continuous AI development
**AI Working Pattern**: Can implement multiple tasks in parallel, focus on testing and validation