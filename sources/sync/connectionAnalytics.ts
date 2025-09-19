/**
 * Connection Analytics and Learning System
 *
 * Provides intelligent connection analytics with machine learning-based optimization
 * for network-aware connection strategies. Tracks connection metrics, identifies
 * failure patterns, and generates optimal settings based on learned data.
 */

import { NetworkProfile } from './networkDetection';

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
  sampleCount: number; // Track number of samples for this metric
  lastUpdated: number;
}

export interface FailurePattern {
  type: 'timeout' | 'network_error' | 'server_error';
  frequency: number;
  timePattern: string; // e.g., "morning", "evening", "weekend"
  context: string; // e.g., "during_background", "network_switch"
  lastOccurrence: number;
}

export interface ConnectionEvent {
  networkProfile: NetworkProfile;
  success: boolean;
  latency?: number;
  failureType?: 'timeout' | 'network_error' | 'server_error';
  context?: string;
  heartbeatInterval?: number;
  timestamp: number;
  dataUsed?: number;
  batteryDelta?: number;
}

export interface OptimalSettings {
  heartbeatInterval: number;
  connectionTimeout: number;
  retryStrategy: RetryStrategy;
  transportPriority: string[];
}

export interface RetryStrategy {
  maxRetries: number;
  baseDelay: number;
  backoffMultiplier: number;
  jitter: boolean;
}

export interface PerformanceReport {
  totalSamples: number;
  overallSuccessRate: number;
  networkBreakdown: Array<{ networkType: string; successRate: number; avgLatency: number; sampleCount: number }>;
  commonFailures: FailurePattern[];
  recommendations: string[];
  generatedAt: number;
  learningEffectiveness?: number; // Improvement percentage
}

/**
 * Simple Machine Learning Model for Connection Optimization
 * Uses linear regression for optimal parameter prediction
 */
class SimpleMLModel {
  private weights: Map<string, number> = new Map();
  private trainingData: Array<{ features: number[]; target: number }> = [];
  private learningRate = 0.01;
  private predictions: Array<{ predicted: number; actual: number }> = [];

  constructor() {
    // Initialize default weights
    this.weights.set('latency', -0.1);
    this.weights.set('successRate', 1.0);
    this.weights.set('networkQuality', 0.5);
    this.weights.set('timeOfDay', 0.1);
  }

  train(features: number[], target: number) {
    // Store training data for batch processing
    this.trainingData.push({ features: [...features], target });

    // Perform simple gradient descent
    this.performGradientDescent(features, target);

    // Keep only recent training data (rolling window)
    if (this.trainingData.length > 1000) {
      this.trainingData = this.trainingData.slice(-500);
    }
  }

  private performGradientDescent(features: number[], target: number) {
    const prediction = this.predict(features);
    const error = target - prediction;

    // Update weights based on error
    const featureNames = ['latency', 'successRate', 'networkQuality', 'timeOfDay'];
    features.forEach((feature, index) => {
      if (index < featureNames.length) {
        const currentWeight = this.weights.get(featureNames[index]) || 0;
        const newWeight = currentWeight + this.learningRate * error * feature;
        this.weights.set(featureNames[index], newWeight);
      }
    });
  }

  predict(features: number[]): number {
    if (features.length === 0) return 30000; // Default heartbeat

    let prediction = 5000; // Base prediction
    const featureNames = ['latency', 'successRate', 'networkQuality', 'timeOfDay'];

    features.forEach((feature, index) => {
      if (index < featureNames.length) {
        const weight = this.weights.get(featureNames[index]) || 0;
        prediction += weight * feature;
      }
    });

    // Clamp to reasonable range
    return Math.max(5000, Math.min(60000, prediction));
  }

  recordPredictionAccuracy(predicted: number, actual: number) {
    this.predictions.push({ predicted, actual });
    // Keep only recent predictions for accuracy calculation
    if (this.predictions.length > 100) {
      this.predictions = this.predictions.slice(-50);
    }
  }

  getAccuracy(): number {
    if (this.predictions.length < 10) return 0;

    const errors = this.predictions.map(p =>
      Math.abs(p.predicted - p.actual) / Math.max(p.actual, 1)
    );
    const avgError = errors.reduce((sum, err) => sum + err, 0) / errors.length;

    return Math.max(0, 1 - avgError); // Convert error to accuracy
  }

  getTrainingDataSize(): number {
    return this.trainingData.length;
  }
}

/**
 * Main Connection Analytics Class
 * Provides comprehensive connection monitoring and optimization
 */
export class ConnectionAnalytics {
  private metrics: Map<string, ConnectionMetrics> = new Map();
  private learningModel: SimpleMLModel;
  private readonly LEARNING_THRESHOLD = 10; // Minimum samples for learning
  private readonly MAX_METRICS_STORAGE = 50; // Limit stored metrics
  private latencyTests: Array<{ timestamp: number; latency: number; source: string }> = [];
  private baselinePerformance: Map<string, number> = new Map();

  constructor() {
    this.learningModel = new SimpleMLModel();
    this.loadStoredMetrics();
  }

  /**
   * Record a connection event and update metrics
   */
  recordConnectionEvent(event: ConnectionEvent) {
    const startTime = Date.now();

    const key = this.generateMetricsKey(event.networkProfile);
    const existing = this.metrics.get(key) || this.createEmptyMetrics(event.networkProfile);

    // Record baseline performance for learning effectiveness calculation BEFORE updating
    if (!this.baselinePerformance.has(key) && existing.sampleCount === 0) {
      this.baselinePerformance.set(key, event.success ? 1 : 0);
    }

    this.updateMetrics(existing, event);
    this.metrics.set(key, existing);

    // Trigger learning if we have enough data
    if (this.getTotalSamples() >= this.LEARNING_THRESHOLD) {
      this.updateLearningModel(key, existing, event);
    }

    // Add latency test data
    if (event.latency) {
      this.recordLatencyTest(event.latency, event.networkProfile.type);
    }

    this.persistMetrics();

    // Performance requirement: <100ms processing
    const processingTime = Date.now() - startTime;
    if (processingTime > 100) {
      console.warn(`Connection analytics processing took ${processingTime}ms, exceeding 100ms requirement`);
    }
  }

  private updateMetrics(metrics: ConnectionMetrics, event: ConnectionEvent) {
    const alpha = 0.1; // Learning rate for rolling averages

    // Update rolling averages with sample count weighting
    const sampleWeight = Math.min(metrics.sampleCount, 10) / 10;
    const effectiveAlpha = alpha * (1 - sampleWeight * 0.5);

    // Update latency with weighted average
    if (event.latency !== undefined) {
      if (metrics.sampleCount === 0) {
        metrics.avgLatency = event.latency;
      } else {
        metrics.avgLatency = this.updateRollingAverage(
          metrics.avgLatency,
          event.latency,
          effectiveAlpha
        );
      }
    }

    // Update success rate using count-based average for accuracy
    const successValue = event.success ? 1 : 0;
    if (metrics.sampleCount === 0) {
      metrics.successRate = successValue;
    } else {
      // Use actual count-based average for more accurate success rate calculation
      const totalSuccesses = metrics.successRate * metrics.sampleCount + successValue;
      metrics.successRate = totalSuccesses / (metrics.sampleCount + 1);
    }

    // Update data usage and battery impact
    if (event.dataUsed !== undefined) {
      metrics.dataUsage = this.updateRollingAverage(
        metrics.dataUsage,
        event.dataUsed,
        effectiveAlpha
      );
    }

    if (event.batteryDelta !== undefined) {
      metrics.batteryImpact = this.updateRollingAverage(
        metrics.batteryImpact,
        event.batteryDelta,
        effectiveAlpha
      );
    }

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

    // Update sample count and timestamp
    metrics.sampleCount++;
    metrics.lastUpdated = event.timestamp;
    metrics.timeOfDay = this.getTimeOfDayScore(event.timestamp);
  }

  private updateFailurePattern(metrics: ConnectionMetrics, event: ConnectionEvent) {
    const timeContext = this.getTimeContext(event.timestamp);
    const existingPattern = metrics.failurePatterns.find(
      p => p.type === event.failureType && p.timePattern === timeContext
    );

    if (existingPattern) {
      existingPattern.frequency++;
      existingPattern.lastOccurrence = event.timestamp;
    } else {
      metrics.failurePatterns.push({
        type: event.failureType!,
        frequency: 1,
        timePattern: timeContext,
        context: event.context || 'unknown',
        lastOccurrence: event.timestamp
      });
    }

    // Keep only top 10 failure patterns, sorted by frequency
    metrics.failurePatterns.sort((a, b) => b.frequency - a.frequency);
    metrics.failurePatterns = metrics.failurePatterns.slice(0, 10);
  }

  private updateLearningModel(metricsKey: string, metrics: ConnectionMetrics, event: ConnectionEvent) {
    // Prepare features for ML model
    const features = [
      metrics.avgLatency / 1000, // Normalize latency to seconds
      metrics.successRate,
      this.getNetworkQualityScore(event.networkProfile),
      this.getTimeOfDayScore(event.timestamp)
    ];

    // Target is optimal heartbeat interval
    const target = event.heartbeatInterval || metrics.optimalHeartbeat;

    // Record prediction accuracy if we have a heartbeat interval to predict
    if (event.heartbeatInterval && metrics.sampleCount > 1) {
      const prediction = this.learningModel.predict(features);
      this.learningModel.recordPredictionAccuracy(prediction, event.heartbeatInterval);
    }

    this.learningModel.train(features, target);
  }

  /**
   * Get optimal settings based on learned data
   */
  getOptimalSettings(networkProfile: NetworkProfile): OptimalSettings {
    const key = this.generateMetricsKey(networkProfile);
    const metrics = this.metrics.get(key);

    if (!metrics || metrics.sampleCount < this.LEARNING_THRESHOLD) {
      return this.getDefaultSettings(networkProfile);
    }

    // Use ML model for prediction
    const features = [
      metrics.avgLatency / 1000,
      metrics.successRate,
      this.getNetworkQualityScore(networkProfile),
      this.getTimeOfDayScore(Date.now())
    ];

    const predictedHeartbeat = this.learningModel.predict(features);

    return {
      heartbeatInterval: Math.round(predictedHeartbeat),
      connectionTimeout: this.calculateOptimalTimeout(metrics),
      retryStrategy: this.calculateOptimalRetryStrategy(metrics),
      transportPriority: this.calculateOptimalTransports(metrics, networkProfile)
    };
  }

  private calculateOptimalTimeout(metrics: ConnectionMetrics): number {
    // Base timeout on average latency + buffer
    const baseTimeout = metrics.avgLatency * 5; // 5x latency as base
    const reliabilityFactor = 1 + (1 - metrics.successRate); // More buffer for unreliable connections

    return Math.max(5000, Math.min(30000, baseTimeout * reliabilityFactor));
  }

  private calculateOptimalRetryStrategy(metrics: ConnectionMetrics): RetryStrategy {
    const baseDelay = Math.max(500, metrics.avgLatency * 2);
    const maxRetries = metrics.successRate > 0.9 ? 3 :
                     metrics.successRate > 0.7 ? 5 : 7;

    return {
      maxRetries,
      baseDelay: Math.max(500, Math.min(5000, baseDelay)),
      backoffMultiplier: metrics.successRate > 0.8 ? 1.5 : 2.0,
      jitter: true
    };
  }

  private calculateOptimalTransports(metrics: ConnectionMetrics, profile: NetworkProfile): string[] {
    const transports = ['websocket', 'polling'];

    // Prioritize based on network type and success rate
    if (profile.type === 'cellular' && metrics.successRate < 0.8) {
      return ['polling', 'websocket']; // Polling more reliable on poor cellular
    }

    return transports;
  }

  /**
   * Generate comprehensive performance report
   */
  generatePerformanceReport(): PerformanceReport {
    const totalSamples = this.getTotalSamples();
    const overallSuccessRate = this.calculateOverallSuccessRate();
    const recommendations = this.generateRecommendations();
    const learningEffectiveness = this.calculateLearningEffectiveness();

    return {
      totalSamples,
      overallSuccessRate,
      networkBreakdown: this.getNetworkBreakdown(),
      commonFailures: this.getCommonFailures(),
      recommendations,
      generatedAt: Date.now(),
      learningEffectiveness
    };
  }

  private calculateLearningEffectiveness(): number {
    // Calculate improvement in success rate after learning threshold
    let totalImprovement = 0;
    let networkTypesWithData = 0;

    this.metrics.forEach((metrics, key) => {
      if (metrics.sampleCount >= this.LEARNING_THRESHOLD) {
        const baseline = this.baselinePerformance.get(key);
        if (baseline !== undefined) {
          const improvement = metrics.successRate - baseline;
          totalImprovement += improvement;
          networkTypesWithData++;
        }
      }
    });

    return networkTypesWithData > 0 ?
      (totalImprovement / networkTypesWithData) * 100 : 0;
  }

  private generateRecommendations(): string[] {
    const recommendations: string[] = [];
    const overallSuccessRate = this.calculateOverallSuccessRate();

    if (overallSuccessRate < 0.9) {
      recommendations.push('Consider enabling aggressive heartbeat profile for improved reliability');
    }

    // Network-specific recommendations
    const cellularMetrics = Array.from(this.metrics.values())
      .find(m => m.networkType.includes('cellular'));

    if (cellularMetrics && cellularMetrics.successRate < 0.8) {
      recommendations.push('Cellular connection quality is poor - consider cellular-specific optimizations');
    }

    const wifiMetrics = Array.from(this.metrics.values())
      .find(m => m.networkType.includes('wifi'));

    if (wifiMetrics && wifiMetrics.avgLatency > 500) {
      recommendations.push('WiFi latency is high - consider reducing heartbeat frequency');
    }

    // Failure pattern recommendations
    const failurePatterns = this.getCommonFailures();
    if (failurePatterns.some(f => f.type === 'timeout' && f.frequency > 5)) {
      recommendations.push('Frequent timeouts detected - consider increasing connection timeouts');
    }

    if (failurePatterns.some(f => f.type === 'network_error' && f.frequency > 3)) {
      recommendations.push('Network errors detected - consider implementing network change detection');
    }

    // Learning effectiveness recommendations
    const learningAccuracy = this.learningModel.getAccuracy();
    if (learningAccuracy < 0.85 && this.getTotalSamples() > 100) {
      recommendations.push('ML model accuracy below target - consider collecting more diverse training data');
    }

    // Battery impact recommendations
    const highBatteryImpact = Array.from(this.metrics.values())
      .some(m => m.batteryImpact > 0.1);

    if (highBatteryImpact) {
      recommendations.push('High battery impact detected - consider reducing heartbeat frequency during low battery');
    }

    return recommendations.length > 0 ? recommendations : ['Connection performance is optimal - no recommendations'];
  }

  private getNetworkBreakdown(): Array<{ networkType: string; successRate: number; avgLatency: number; sampleCount: number }> {
return Array.from(this.metrics.entries()).map(([, metrics]) => ({
      networkType: metrics.networkType,
      successRate: Math.round(metrics.successRate * 10000) / 100, // Percentage with 2 decimals
      avgLatency: Math.round(metrics.avgLatency),
      sampleCount: metrics.sampleCount
    }));
  }

  private getCommonFailures(): FailurePattern[] {
    const allFailures: FailurePattern[] = [];

    this.metrics.forEach(metrics => {
      allFailures.push(...metrics.failurePatterns);
    });

    // Aggregate failures by type and sort by frequency
    const aggregated = new Map<string, FailurePattern>();
    allFailures.forEach(failure => {
      const key = `${failure.type}_${failure.timePattern}`;
      const existing = aggregated.get(key);

      if (existing) {
        existing.frequency += failure.frequency;
        existing.lastOccurrence = Math.max(existing.lastOccurrence, failure.lastOccurrence);
      } else {
        aggregated.set(key, { ...failure });
      }
    });

    return Array.from(aggregated.values())
      .sort((a, b) => b.frequency - a.frequency)
      .slice(0, 10);
  }

  /**
   * Multi-source latency testing for network quality assessment
   */
  async performLatencyTests(): Promise<Array<{ source: string; latency: number; success: boolean }>> {
    const testSources = [
      'https://www.google.com/generate_204',
      'https://www.cloudflare.com/cdn-cgi/trace',
      'https://httpbin.org/status/200'
    ];

    const results = await Promise.allSettled(
      testSources.map(async (url) => {
        const startTime = Date.now();
        try {
          const response = await fetch(url, {
            method: 'GET',
            cache: 'no-cache',
            signal: AbortSignal.timeout(5000)
          });
          const latency = Date.now() - startTime;
          return {
            source: new URL(url).hostname,
            latency,
            success: response.ok
          };
        } catch {
          return {
            source: new URL(url).hostname,
            latency: Date.now() - startTime,
            success: false
          };
        }
      })
    );

    return results
      .filter((result): result is PromiseFulfilledResult<any> => result.status === 'fulfilled')
      .map(result => result.value);
  }

  private recordLatencyTest(latency: number, source: string) {
    this.latencyTests.push({
      timestamp: Date.now(),
      latency,
      source
    });

    // Keep only recent tests (last 100)
    if (this.latencyTests.length > 100) {
      this.latencyTests = this.latencyTests.slice(-50);
    }
  }

  // Helper methods
  private generateMetricsKey(profile: NetworkProfile): string {
    return `${profile.type}_${profile.quality}_${profile.isExpensive ? 'expensive' : 'free'}`;
  }

  private createEmptyMetrics(profile: NetworkProfile): ConnectionMetrics {
    return {
      networkType: `${profile.type}_${profile.quality}`,
      avgLatency: 0,
      successRate: 1,
      failurePatterns: [],
      optimalHeartbeat: 30000, // Default 30s
      reconnectSuccessRate: 1,
      dataUsage: 0,
      batteryImpact: 0,
      timeOfDay: this.getTimeOfDayScore(Date.now()),
      sampleCount: 0,
      lastUpdated: Date.now()
    };
  }

  private updateRollingAverage(current: number, newValue: number, alpha: number): number {
    return current * (1 - alpha) + newValue * alpha;
  }

  private calculateOptimalHeartbeat(metrics: ConnectionMetrics, currentInterval: number, latency: number): number {
    // Simple heuristic: optimize based on success rate and latency
    const targetSuccessRate = 0.95;
    const successFactor = metrics.successRate / targetSuccessRate;
    const latencyFactor = Math.max(0.5, Math.min(2.0, latency / 200)); // 200ms baseline

    const optimal = currentInterval * successFactor * latencyFactor;

    // Clamp to reasonable range
    return Math.max(5000, Math.min(60000, optimal));
  }

  private getTimeContext(timestamp: number = Date.now()): string {
    const date = new Date(timestamp);
    const hour = date.getHours();
    const isWeekend = date.getDay() === 0 || date.getDay() === 6;

    if (isWeekend) return 'weekend';
    if (hour >= 6 && hour < 12) return 'morning';
    if (hour >= 12 && hour < 18) return 'afternoon';
    if (hour >= 18 && hour < 22) return 'evening';
    return 'night';
  }

  private getTimeOfDayScore(timestamp: number): number {
    const hour = new Date(timestamp).getHours();
    // Normalize hour to 0-1 scale (peak activity around noon)
    return Math.sin((hour - 6) * Math.PI / 12);
  }

  private getNetworkQualityScore(profile: NetworkProfile): number {
    const qualityMap = { excellent: 1.0, good: 0.7, poor: 0.3, unknown: 0.5 };
    return qualityMap[profile.quality] || 0.5;
  }

  private getDefaultSettings(profile: NetworkProfile): OptimalSettings {
    const baseSettings = {
      heartbeatInterval: 30000,
      connectionTimeout: 15000,
      retryStrategy: {
        maxRetries: 3,
        baseDelay: 1000,
        backoffMultiplier: 2.0,
        jitter: true
      },
      transportPriority: ['websocket', 'polling']
    };

    // Adjust for network type
    if (profile.type === 'cellular') {
      baseSettings.heartbeatInterval = 45000; // Longer for cellular
      baseSettings.connectionTimeout = 20000;
      baseSettings.retryStrategy.maxRetries = 5;
    } else if (profile.quality === 'poor') {
      baseSettings.heartbeatInterval = 60000; // Much longer for poor connections
      baseSettings.connectionTimeout = 25000;
      baseSettings.retryStrategy.maxRetries = 7;
    }

    return baseSettings;
  }

  private getTotalSamples(): number {
    return Array.from(this.metrics.values())
      .reduce((total, metrics) => total + metrics.sampleCount, 0);
  }

  private calculateOverallSuccessRate(): number {
    const metrics = Array.from(this.metrics.values());
    if (metrics.length === 0) return 1;

    const weightedSum = metrics.reduce((sum, metric) =>
      sum + metric.successRate * metric.sampleCount, 0);
    const totalSamples = this.getTotalSamples();

    return totalSamples > 0 ? weightedSum / totalSamples : 1;
  }

  private loadStoredMetrics() {
    // Implementation would load from AsyncStorage or similar
    // For now, start with empty metrics
  }

  private persistMetrics() {
    // Implementation would save to AsyncStorage or similar
    // Ensure we don't exceed storage limits
    if (this.metrics.size > this.MAX_METRICS_STORAGE) {
      // Remove oldest metrics
      const sortedEntries = Array.from(this.metrics.entries())
        .sort(([, a], [, b]) => a.lastUpdated - b.lastUpdated);

      const toRemove = sortedEntries.slice(0, this.metrics.size - this.MAX_METRICS_STORAGE);
      toRemove.forEach(([key]) => this.metrics.delete(key));
    }
  }

  // Public methods for testing and monitoring
  getMetrics(): Map<string, ConnectionMetrics> {
    return new Map(this.metrics);
  }

  getModelAccuracy(): number {
    return this.learningModel.getAccuracy();
  }

  getTrainingDataSize(): number {
    return this.learningModel.getTrainingDataSize();
  }

  getLatencyTestHistory(): Array<{ timestamp: number; latency: number; source: string }> {
    return [...this.latencyTests];
  }

  // Reset methods for testing
  clearMetrics() {
    this.metrics.clear();
    this.baselinePerformance.clear();
    this.latencyTests = [];
  }

  // Force learning update for testing
  forceLearningUpdate() {
    this.metrics.forEach((metrics, key) => {
      if (metrics.sampleCount > 0) {
        const dummyEvent: ConnectionEvent = {
          networkProfile: { type: 'wifi', quality: 'good', stability: 0.9, strength: 80, isExpensive: false, isInternetReachable: true },
          success: true,
          latency: metrics.avgLatency,
          timestamp: Date.now()
        };
        this.updateLearningModel(key, metrics, dummyEvent);
      }
    });
  }
}

// Export singleton instance
export const connectionAnalytics = new ConnectionAnalytics();