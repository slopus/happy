/**
 * Utility functions for connection analytics
 */

import { ConnectionMetrics, OptimalSettings, RetryStrategy } from '../connectionAnalytics';
import { NetworkProfile } from '../networkDetection';

export class ConnectionAnalyticsUtils {
  static generateMetricsKey(profile: NetworkProfile): string {
    return `${profile.type}_${profile.quality}_${profile.isExpensive ? 'expensive' : 'free'}`;
  }

  static createEmptyMetrics(profile: NetworkProfile): ConnectionMetrics {
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
      lastUpdated: Date.now(),
    };
  }

  static updateRollingAverage(current: number, newValue: number, alpha: number): number {
    return current * (1 - alpha) + newValue * alpha;
  }

  static calculateOptimalHeartbeat(metrics: ConnectionMetrics, currentInterval: number, latency: number): number {
    // Simple heuristic: optimize based on success rate and latency
    const targetSuccessRate = 0.95;
    const successFactor = metrics.successRate / targetSuccessRate;
    const latencyFactor = Math.max(0.5, Math.min(2.0, latency / 200)); // 200ms baseline

    const optimal = currentInterval * successFactor * latencyFactor;

    // Clamp to reasonable range
    return Math.max(5000, Math.min(60000, optimal));
  }

  static getTimeContext(timestamp: number = Date.now()): string {
    const date = new Date(timestamp);
    const hour = date.getHours();
    const isWeekend = date.getDay() === 0 || date.getDay() === 6;

    if (isWeekend) return 'weekend';
    if (hour >= 6 && hour < 12) return 'morning';
    if (hour >= 12 && hour < 18) return 'afternoon';
    if (hour >= 18 && hour < 22) return 'evening';
    return 'night';
  }

  static getTimeOfDayScore(timestamp: number): number {
    const hour = new Date(timestamp).getHours();
    // Normalize hour to 0-1 scale (peak activity around noon)
    return Math.sin((hour - 6) * Math.PI / 12);
  }

  static getNetworkQualityScore(profile: NetworkProfile): number {
    const qualityMap = { excellent: 1.0, good: 0.7, poor: 0.3, unknown: 0.5 };
    return qualityMap[profile.quality] || 0.5;
  }

  static calculateOptimalTimeout(metrics: ConnectionMetrics): number {
    // Base timeout on average latency + buffer
    const baseTimeout = metrics.avgLatency * 5; // 5x latency as base
    const reliabilityFactor = 1 + (1 - metrics.successRate); // More buffer for unreliable connections

    return Math.max(5000, Math.min(30000, baseTimeout * reliabilityFactor));
  }

  static calculateOptimalRetryStrategy(metrics: ConnectionMetrics): RetryStrategy {
    const baseDelay = Math.max(500, metrics.avgLatency * 2);
    const maxRetries = metrics.successRate > 0.9 ? 3 :
      metrics.successRate > 0.7 ? 5 : 7;

    return {
      maxRetries,
      baseDelay: Math.max(500, Math.min(5000, baseDelay)),
      backoffMultiplier: metrics.successRate > 0.8 ? 1.5 : 2.0,
      jitter: true,
    };
  }

  static calculateOptimalTransports(metrics: ConnectionMetrics, profile: NetworkProfile): string[] {
    const transports = ['websocket', 'polling'];

    // Prioritize based on network type and success rate
    if (profile.type === 'cellular' && metrics.successRate < 0.8) {
      return ['polling', 'websocket']; // Polling more reliable on poor cellular
    }

    return transports;
  }

  static getDefaultSettings(profile: NetworkProfile): OptimalSettings {
    const baseSettings = {
      heartbeatInterval: 30000,
      connectionTimeout: 15000,
      retryStrategy: {
        maxRetries: 3,
        baseDelay: 1000,
        backoffMultiplier: 2.0,
        jitter: true,
      },
      transportPriority: ['websocket', 'polling'],
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
}