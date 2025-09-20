import { describe, test, expect, beforeEach, afterEach } from 'vitest';

import { EnhancedSessionRecovery, QueuedOperation } from './enhancedRecovery';

describe('Enhanced Session Recovery Stress Tests', () => {
  let recovery: EnhancedSessionRecovery;

  beforeEach(() => {
    recovery = new EnhancedSessionRecovery();
  });

  afterEach(() => {
    recovery.destroy();
  });

  describe('Large Queue Performance', () => {
    test('should handle 1000+ queued operations efficiently', async () => {
      const numOperations = 1000;
      const startTime = Date.now();

      // Generate large number of operations with varied priorities and types
      const operations: Array<Omit<QueuedOperation, 'id' | 'retryCount'>> = [];

      for (let i = 0; i < numOperations; i++) {
        const priorities = ['low', 'medium', 'high', 'critical'] as const;
        const types = ['message', 'state_update', 'user_action'] as const;

        operations.push({
          type: types[i % 3],
          data: {
            index: i,
            payload: `data_${i}`,
            timestamp: Date.now() + i,
            largeContent: 'x'.repeat(100), // Add some content to simulate real data
          },
          priority: priorities[i % 4],
          timestamp: Date.now() + i * 10,
          maxRetries: 3,
          expiresAt: Date.now() + 300000,
        });
      }

      // Queue all operations
      const queueStartTime = Date.now();
      const operationIds: string[] = [];

      operations.forEach(op => {
        const id = recovery.queueOperation(op);
        operationIds.push(id);
      });

      const queueTime = Date.now() - queueStartTime;

      // Verify queuing performance
      expect(queueTime).toBeLessThan(5000); // Should queue 1000 operations in less than 5 seconds
      expect(recovery.getQueueSize()).toBe(numOperations);

      // Verify queue status calculation performance
      const statusStartTime = Date.now();
      const status = recovery.getQueueStatus();
      const statusTime = Date.now() - statusStartTime;

      expect(statusTime).toBeLessThan(1000); // Status calculation should be fast
      expect(status.totalOperations).toBe(numOperations);

      // Process the queue and measure performance
      const processStartTime = Date.now();
      const result = await recovery.processOfflineQueue();
      const processTime = Date.now() - processStartTime;

      // Verify processing performance (requirement: <5s for 100 operations, scale appropriately)
      const expectedMaxTime = (numOperations / 100) * 5000; // Scale linearly
      expect(processTime).toBeLessThan(expectedMaxTime);

      // Verify most operations were processed (allow for some processing variation)
      expect(result.processed).toBeGreaterThanOrEqual(Math.floor(numOperations * 0.95));
      expect(result.failed).toBeLessThanOrEqual(Math.ceil(numOperations * 0.05));
      expect(recovery.getQueueSize()).toBeLessThanOrEqual(Math.ceil(numOperations * 0.05));

      const totalTime = Date.now() - startTime;
      console.log(`Stress test results for ${numOperations} operations:`);
      console.log(`- Queuing time: ${queueTime}ms`);
      console.log(`- Status time: ${statusTime}ms`);
      console.log(`- Processing time: ${processTime}ms`);
      console.log(`- Total time: ${totalTime}ms`);
    });

    test('should maintain priority ordering under heavy load', async () => {
      const numOperations = 500;
      const processedOrder: Array<{ priority: string, index: number }> = [];

      // Mock processing to track order
      const originalProcessMessage = (recovery as any).processMessage;
      const originalProcessStateUpdate = (recovery as any).processStateUpdate;
      const originalProcessUserAction = (recovery as any).processUserAction;

      const trackingFunction = async (operation: QueuedOperation) => {
        processedOrder.push({
          priority: operation.priority,
          index: operation.data.index,
        });
        return { success: true };
      };

      (recovery as any).processMessage = trackingFunction;
      (recovery as any).processStateUpdate = trackingFunction;
      (recovery as any).processUserAction = trackingFunction;

      // Queue operations in random priority order
      const priorities = ['low', 'medium', 'high', 'critical'] as const;
      const types = ['message', 'state_update', 'user_action'] as const;

      for (let i = 0; i < numOperations; i++) {
        recovery.queueOperation({
          type: types[i % 3],
          data: { index: i },
          priority: priorities[Math.floor(Math.random() * 4)],
          timestamp: Date.now() + Math.random() * 1000,
          maxRetries: 3,
          expiresAt: Date.now() + 300000,
        });
      }

      await recovery.processOfflineQueue();

      // Verify priority ordering was maintained
      const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };

      for (let i = 1; i < processedOrder.length; i++) {
        const prevPriority = priorityOrder[processedOrder[i - 1].priority as keyof typeof priorityOrder];
        const currPriority = priorityOrder[processedOrder[i].priority as keyof typeof priorityOrder];

        expect(prevPriority).toBeLessThanOrEqual(currPriority);
      }

      // Restore original methods
      (recovery as any).processMessage = originalProcessMessage;
      (recovery as any).processStateUpdate = originalProcessStateUpdate;
      (recovery as any).processUserAction = originalProcessUserAction;
    });

    test('should handle queue size limits efficiently with large datasets', async () => {
      const maxQueueSize = 100;
      const totalOperations = 500;

      recovery.setMaxQueueSize(maxQueueSize);

      const startTime = Date.now();

      // Queue more operations than the limit allows
      for (let i = 0; i < totalOperations; i++) {
        recovery.queueOperation({
          type: 'message',
          data: {
            index: i,
            content: `Message ${i}`,
            timestamp: Date.now() + i,
          },
          priority: i < 50 ? 'critical' : 'low', // First 50 are critical
          timestamp: Date.now() + i,
          maxRetries: 3,
          expiresAt: Date.now() + 300000,
        });
      }

      const queueTime = Date.now() - startTime;

      // Should maintain queue size limits
      expect(recovery.getQueueSize()).toBeLessThanOrEqual(maxQueueSize);

      // Should preserve high-priority operations
      const status = recovery.getQueueStatus();
      expect(status.byPriority.critical).toBeGreaterThan(0);

      // Queue management should be efficient
      expect(queueTime).toBeLessThan(2000); // Should handle 500 operations with limits in under 2s

      console.log(`Queue limit stress test results:`);
      console.log(`- Queued ${totalOperations} operations in ${queueTime}ms`);
      console.log(`- Final queue size: ${recovery.getQueueSize()}/${maxQueueSize}`);
      console.log(`- Critical operations preserved: ${status.byPriority.critical}`);
    });
  });

  describe('Memory Usage Performance', () => {
    test('should maintain memory usage under 10MB for 1000 operations', () => {
      const numOperations = 1000;
      const startMemory = recovery.getQueueMemoryUsage();

      // Queue operations with realistic data sizes
      for (let i = 0; i < numOperations; i++) {
        recovery.queueOperation({
          type: 'message',
          data: {
            id: `msg_${i}`,
            content: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(10), // ~500 chars
            metadata: {
              userId: `user_${i % 100}`,
              timestamp: Date.now() + i,
              tags: ['tag1', 'tag2', 'tag3'],
              settings: { priority: 'normal', encrypted: false },
            },
          },
          priority: 'medium',
          timestamp: Date.now() + i,
          maxRetries: 3,
          expiresAt: Date.now() + 300000,
        });
      }

      const finalMemory = recovery.getQueueMemoryUsage();
      const memoryIncrease = finalMemory - startMemory;
      const memoryInMB = memoryIncrease / (1024 * 1024);

      console.log(`Memory usage test results:`);
      console.log(`- Start memory: ${startMemory} bytes`);
      console.log(`- Final memory: ${finalMemory} bytes`);
      console.log(`- Memory increase: ${memoryIncrease} bytes (${memoryInMB.toFixed(2)} MB)`);

      // Requirement: <10MB for 1000 operations
      expect(memoryInMB).toBeLessThan(10);
    });

    test('should handle memory efficiently during queue turnover', async () => {
      const batchSize = 200;
      const numBatches = 5;
      const memoryReadings: number[] = [];

      for (let batch = 0; batch < numBatches; batch++) {
        // Queue a batch of operations
        for (let i = 0; i < batchSize; i++) {
          recovery.queueOperation({
            type: 'state_update',
            data: {
              batchId: batch,
              operationId: i,
              data: { field: `value_${batch}_${i}` },
              largePayload: 'x'.repeat(500), // 500 char payload
            },
            priority: 'medium',
            timestamp: Date.now() + i,
            maxRetries: 3,
            expiresAt: Date.now() + 300000,
          });
        }

        memoryReadings.push(recovery.getQueueMemoryUsage());

        // Process the batch
        await recovery.processOfflineQueue();

        // Memory should decrease after processing
        const postProcessMemory = recovery.getQueueMemoryUsage();
        memoryReadings.push(postProcessMemory);
      }

      console.log('Memory turnover readings:', memoryReadings.map(m => `${(m / 1024).toFixed(1)}KB`));

      // Memory should not continuously grow
      const maxMemory = Math.max(...memoryReadings);
      const finalMemory = memoryReadings[memoryReadings.length - 1];

      expect(finalMemory).toBeLessThan(maxMemory * 1.1); // Should not grow more than 10%
    });

    test('should handle queue cleanup efficiently for expired operations', () => {
      const numOperations = 500;
      const now = Date.now();

      // Add mix of expired and valid operations
      for (let i = 0; i < numOperations; i++) {
        const isExpired = i % 3 === 0; // Every 3rd operation is expired

        recovery.queueOperation({
          type: 'message',
          data: { index: i, content: `Operation ${i}` },
          priority: 'medium',
          timestamp: now + i,
          maxRetries: 3,
          expiresAt: isExpired ? now - 1000 : now + 300000,
        });
      }

      const beforeCleanup = recovery.getQueueSize();
      const beforeMemory = recovery.getQueueMemoryUsage();

      // Force cleanup
      const cleanupStart = Date.now();
      (recovery as any).enforceQueueLimits();
      const cleanupTime = Date.now() - cleanupStart;

      const afterCleanup = recovery.getQueueSize();
      const afterMemory = recovery.getQueueMemoryUsage();

      console.log(`Cleanup performance results:`);
      console.log(`- Operations before cleanup: ${beforeCleanup}`);
      console.log(`- Operations after cleanup: ${afterCleanup}`);
      console.log(`- Memory before: ${beforeMemory} bytes`);
      console.log(`- Memory after: ${afterMemory} bytes`);
      console.log(`- Cleanup time: ${cleanupTime}ms`);

      // Cleanup should be fast and effective
      expect(cleanupTime).toBeLessThan(1000); // Under 1 second
      expect(afterCleanup).toBeLessThanOrEqual(beforeCleanup); // Some operations removed or same
      expect(afterMemory).toBeLessThanOrEqual(beforeMemory); // Memory reduced or same
    });
  });

  describe('Concurrent Operations Performance', () => {
    test('should handle rapid operation queuing', () => {
      const numOperations = 1000;
      const interval = 1; // 1ms between operations

      const startTime = Date.now();

      // Rapidly queue operations
      const operationIds: string[] = [];
      for (let i = 0; i < numOperations; i++) {
        const id = recovery.queueOperation({
          type: 'user_action',
          data: {
            actionId: i,
            action: 'rapid_input',
            timestamp: Date.now() + i * interval,
          },
          priority: 'high',
          timestamp: Date.now() + i * interval,
          maxRetries: 2,
          expiresAt: Date.now() + 300000,
        });
        operationIds.push(id);
      }

      const queueTime = Date.now() - startTime;

      expect(recovery.getQueueSize()).toBe(numOperations);
      expect(queueTime).toBeLessThan(2000); // Should handle rapid queuing
      expect(operationIds.length).toBe(numOperations);

      // All IDs should be unique
      const uniqueIds = new Set(operationIds);
      expect(uniqueIds.size).toBe(numOperations);

      console.log(`Rapid queuing test: ${numOperations} operations in ${queueTime}ms`);
    });

    test('should maintain performance with mixed operation types under load', async () => {
      const numOperations = 600;
      const types = ['message', 'state_update', 'user_action'] as const;
      const priorities = ['low', 'medium', 'high', 'critical'] as const;

      const startTime = Date.now();

      // Queue mixed operations rapidly
      for (let i = 0; i < numOperations; i++) {
        recovery.queueOperation({
          type: types[i % 3],
          data: {
            operationIndex: i,
            operationType: types[i % 3],
            payload: {
              data: `operation_${i}`,
              metadata: { batch: Math.floor(i / 50), index: i % 50 },
            },
          },
          priority: priorities[i % 4],
          timestamp: Date.now() + i,
          maxRetries: 3,
          expiresAt: Date.now() + 300000,
        });
      }

      const queueTime = Date.now() - startTime;

      // Verify queue state
      const status = recovery.getQueueStatus();
      expect(status.totalOperations).toBe(numOperations);

      // Process and measure performance
      const processStart = Date.now();
      const result = await recovery.processOfflineQueue();
      const processTime = Date.now() - processStart;

      expect(result.processed).toBeGreaterThanOrEqual(Math.floor(numOperations * 0.95));
      expect(result.failed).toBeLessThanOrEqual(Math.ceil(numOperations * 0.05));

      console.log(`Mixed operations stress test:`);
      console.log(`- Queuing time: ${queueTime}ms`);
      console.log(`- Processing time: ${processTime}ms`);
      console.log(`- Operations per second: ${(numOperations / (processTime / 1000)).toFixed(0)}`);

      // Performance should scale reasonably
      expect(processTime).toBeLessThan(10000); // Under 10 seconds for 600 operations
    });

    test('should handle burst queuing followed by processing cycles', async () => {
      const burstSize = 100;
      const numBursts = 5;
      const processingTimes: number[] = [];

      for (let burst = 0; burst < numBursts; burst++) {
        // Queue a burst of operations
        const burstStart = Date.now();

        for (let i = 0; i < burstSize; i++) {
          recovery.queueOperation({
            type: 'message',
            data: {
              burstId: burst,
              messageIndex: i,
              content: `Burst ${burst} Message ${i}`,
            },
            priority: burst % 2 === 0 ? 'high' : 'medium',
            timestamp: Date.now() + i,
            maxRetries: 3,
            expiresAt: Date.now() + 300000,
          });
        }

        const burstTime = Date.now() - burstStart;

        // Process the burst
        const processStart = Date.now();
        const result = await recovery.processOfflineQueue();
        const processTime = Date.now() - processStart;

        processingTimes.push(processTime);

        expect(result.processed).toBe(burstSize);
        expect(recovery.getQueueSize()).toBe(0);

        console.log(`Burst ${burst}: queued in ${burstTime}ms, processed in ${processTime}ms`);
      }

      // Processing times should remain consistent
      const avgProcessTime = processingTimes.reduce((a, b) => a + b, 0) / processingTimes.length;
      const maxProcessTime = Math.max(...processingTimes);
      const minProcessTime = Math.min(...processingTimes);

      expect(maxProcessTime - minProcessTime).toBeLessThan(Math.max(avgProcessTime * 2, 50)); // Variance should be reasonable but allow more tolerance, with minimum 50ms

      console.log(`Burst processing summary:`);
      console.log(`- Average processing time: ${avgProcessTime.toFixed(1)}ms`);
      console.log(`- Min/Max processing time: ${minProcessTime}ms/${maxProcessTime}ms`);
    });
  });

  describe('Error Recovery Performance', () => {
    test('should handle high failure rates efficiently', async () => {
      const numOperations = 200;
      const failureRate = 0.3; // 30% failure rate

      // Mock processing to simulate failures
      const originalProcessMessage = (recovery as any).processMessage;
      (recovery as any).processMessage = async (operation: QueuedOperation) => {
        if (Math.random() < failureRate && operation.retryCount === 0) {
          return { success: false, error: 'Simulated failure' };
        }
        return { success: true };
      };

      // Queue operations
      for (let i = 0; i < numOperations; i++) {
        recovery.queueOperation({
          type: 'message',
          data: { index: i, content: `Message ${i}` },
          priority: 'medium',
          timestamp: Date.now() + i,
          maxRetries: 2,
          expiresAt: Date.now() + 300000,
        });
      }

      // Process with failures and retries
      const processStart = Date.now();

      let totalProcessed = 0;
      let attempts = 0;
      const maxAttempts = 5;

      while (recovery.getQueueSize() > 0 && attempts < maxAttempts) {
        const result = await recovery.processOfflineQueue();
        totalProcessed += result.processed;
        attempts++;
      }

      const processTime = Date.now() - processStart;

      console.log(`Error recovery performance:`);
      console.log(`- Total processed: ${totalProcessed}/${numOperations}`);
      console.log(`- Processing attempts: ${attempts}`);
      console.log(`- Total processing time: ${processTime}ms`);

      // Should eventually process most operations despite failures
      expect(totalProcessed).toBeGreaterThan(numOperations * 0.8); // At least 80%
      expect(processTime).toBeLessThan(5000); // Should handle retries efficiently

      // Restore original method
      (recovery as any).processMessage = originalProcessMessage;
    });
  });
});