import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { EnhancedSessionRecovery, QueuedOperation } from "./enhancedRecovery";

describe("Enhanced Session Recovery", () => {
	let recovery: EnhancedSessionRecovery;

	beforeEach(() => {
		recovery = new EnhancedSessionRecovery();
	});

	afterEach(() => {
		recovery.destroy();
	});

	describe("Priority Queue Management", () => {
		test("should queue operations by priority", () => {
			const lowPriorityId = recovery.queueOperation({
				type: "message",
				data: { text: "low priority" },
				priority: "low",
				timestamp: Date.now(),
				maxRetries: 3,
				expiresAt: Date.now() + 60000,
			});

			const criticalId = recovery.queueOperation({
				type: "message",
				data: { text: "critical" },
				priority: "critical",
				timestamp: Date.now(),
				maxRetries: 5,
				expiresAt: Date.now() + 60000,
			});

			const highId = recovery.queueOperation({
				type: "message",
				data: { text: "high priority" },
				priority: "high",
				timestamp: Date.now(),
				maxRetries: 4,
				expiresAt: Date.now() + 60000,
			});

			const status = recovery.getQueueStatus();
			expect(status.byPriority.critical).toBe(1);
			expect(status.byPriority.high).toBe(1);
			expect(status.byPriority.low).toBe(1);
			expect(status.totalOperations).toBe(3);
		});

		test("should maintain priority order when processing", async () => {
			const processedOrder: string[] = [];

			// Mock the processing methods to track order
			const originalProcessMessage = (recovery as any).processMessage;
			(recovery as any).processMessage = async (operation: QueuedOperation) => {
				processedOrder.push(operation.priority);
				return { success: true };
			};

			// Add operations in reverse priority order
			recovery.queueOperation({
				type: "message",
				data: { text: "low" },
				priority: "low",
				timestamp: Date.now(),
				maxRetries: 3,
				expiresAt: Date.now() + 60000,
			});

			recovery.queueOperation({
				type: "message",
				data: { text: "high" },
				priority: "high",
				timestamp: Date.now(),
				maxRetries: 3,
				expiresAt: Date.now() + 60000,
			});

			recovery.queueOperation({
				type: "message",
				data: { text: "critical" },
				priority: "critical",
				timestamp: Date.now(),
				maxRetries: 3,
				expiresAt: Date.now() + 60000,
			});

			await recovery.processOfflineQueue();

			expect(processedOrder).toEqual(["critical", "high", "low"]);

			// Restore original method
			(recovery as any).processMessage = originalProcessMessage;
		});

		test("should generate unique operation IDs", () => {
			const id1 = recovery.queueOperation({
				type: "message",
				data: { text: "test1" },
				priority: "medium",
				timestamp: Date.now(),
				maxRetries: 3,
				expiresAt: Date.now() + 60000,
			});

			const id2 = recovery.queueOperation({
				type: "message",
				data: { text: "test2" },
				priority: "medium",
				timestamp: Date.now(),
				maxRetries: 3,
				expiresAt: Date.now() + 60000,
			});

			expect(id1).not.toBe(id2);
			expect(id1).toMatch(/^op_\d+_[a-z0-9]+$/);
			expect(id2).toMatch(/^op_\d+_[a-z0-9]+$/);
		});
	});

	describe("Queue Size Management", () => {
		test("should enforce queue size limits", () => {
			recovery.setMaxQueueSize(5);

			// Add 10 low priority operations
			for (let i = 0; i < 10; i++) {
				recovery.queueOperation({
					type: "message",
					data: { text: `message ${i}` },
					priority: "low",
					timestamp: Date.now() + i, // Different timestamps
					maxRetries: 3,
					expiresAt: Date.now() + 60000,
				});
			}

			expect(recovery.getQueueSize()).toBeLessThanOrEqual(5);
		});

		test("should preserve high priority operations when enforcing limits", () => {
			recovery.setMaxQueueSize(3);

			// Add low priority operations first
			recovery.queueOperation({
				type: "message",
				data: { text: "low1" },
				priority: "low",
				timestamp: Date.now(),
				maxRetries: 3,
				expiresAt: Date.now() + 60000,
			});

			recovery.queueOperation({
				type: "message",
				data: { text: "low2" },
				priority: "low",
				timestamp: Date.now() + 1,
				maxRetries: 3,
				expiresAt: Date.now() + 60000,
			});

			// Add critical operations
			recovery.queueOperation({
				type: "message",
				data: { text: "critical1" },
				priority: "critical",
				timestamp: Date.now() + 2,
				maxRetries: 3,
				expiresAt: Date.now() + 60000,
			});

			recovery.queueOperation({
				type: "message",
				data: { text: "critical2" },
				priority: "critical",
				timestamp: Date.now() + 3,
				maxRetries: 3,
				expiresAt: Date.now() + 60000,
			});

			const status = recovery.getQueueStatus();
			expect(status.totalOperations).toBe(3);
			expect(status.byPriority.critical).toBe(2);
		});

		test("should remove expired operations", async () => {
			const expiredTime = Date.now() - 1000; // 1 second ago
			const validTime = Date.now() + 60000; // 1 minute from now

			recovery.queueOperation({
				type: "message",
				data: { text: "expired" },
				priority: "medium",
				timestamp: Date.now(),
				maxRetries: 3,
				expiresAt: expiredTime,
			});

			recovery.queueOperation({
				type: "message",
				data: { text: "valid" },
				priority: "medium",
				timestamp: Date.now(),
				maxRetries: 3,
				expiresAt: validTime,
			});

			// Force queue cleanup
			(recovery as any).enforceQueueLimits();

			expect(recovery.getQueueSize()).toBe(1);
		});
	});

	describe("Operation Processing", () => {
		test("should process operations successfully", async () => {
			recovery.queueOperation({
				type: "message",
				data: { text: "test message" },
				priority: "medium",
				timestamp: Date.now(),
				maxRetries: 3,
				expiresAt: Date.now() + 60000,
			});

			const result = await recovery.processOfflineQueue();

			expect(result.processed).toBe(1);
			expect(result.failed).toBe(0);
			expect(result.errors.length).toBe(0);
			expect(recovery.getQueueSize()).toBe(0);
		});

		test("should handle retry logic for failed operations", async () => {
			// Mock processMessage to fail initially
			let attemptCount = 0;
			const originalProcessMessage = (recovery as any).processMessage;
			(recovery as any).processMessage = async () => {
				attemptCount++;
				if (attemptCount < 3) {
					return { success: false, error: "Temporary failure" };
				}
				return { success: true };
			};

			recovery.queueOperation({
				type: "message",
				data: { text: "retry test" },
				priority: "medium",
				timestamp: Date.now(),
				maxRetries: 5,
				expiresAt: Date.now() + 60000,
			});

			// Process multiple times to trigger retries
			await recovery.processOfflineQueue();
			await recovery.processOfflineQueue();
			const result = await recovery.processOfflineQueue();

			expect(result.processed).toBe(1);
			expect(attemptCount).toBe(3);

			// Restore original method
			(recovery as any).processMessage = originalProcessMessage;
		});

		test("should fail operations after max retries", async () => {
			// Mock processMessage to always fail
			const originalProcessMessage = (recovery as any).processMessage;
			(recovery as any).processMessage = async () => {
				return { success: false, error: "Persistent failure" };
			};

			recovery.queueOperation({
				type: "message",
				data: { text: "fail test" },
				priority: "medium",
				timestamp: Date.now(),
				maxRetries: 2,
				expiresAt: Date.now() + 60000,
			});

			// Process enough times to exceed max retries
			await recovery.processOfflineQueue();
			await recovery.processOfflineQueue();
			const result = await recovery.processOfflineQueue();

			expect(result.failed).toBe(1);
			expect(result.errors.length).toBe(1);
			expect(result.errors[0].error).toBe("Max retries exceeded");
			expect(recovery.getQueueSize()).toBe(0);

			// Restore original method
			(recovery as any).processMessage = originalProcessMessage;
		});
	});

	describe("Conflict Resolution", () => {
		test("should handle message conflicts with timestamp resolution", async () => {
			const now = Date.now();

			// Mock processStateUpdate to return conflict
			const originalProcessStateUpdate = (recovery as any).processStateUpdate;
			(recovery as any).processStateUpdate = async (
				operation: QueuedOperation,
			) => {
				return {
					success: false,
					conflict: true,
					conflictData: { timestamp: now - 1000 }, // Older timestamp
				};
			};

			recovery.queueOperation({
				type: "state_update",
				data: { timestamp: now, value: "local" },
				priority: "medium",
				timestamp: now,
				maxRetries: 3,
				expiresAt: now + 60000,
			});

			const result = await recovery.processOfflineQueue();

			expect(result.conflicts).toBe(1);

			// Restore original method
			(recovery as any).processStateUpdate = originalProcessStateUpdate;
		});

		test("should merge state updates correctly", () => {
			const local = {
				field1: { value: "local1", lastModified: 1000 },
				field2: { value: "local2", lastModified: 2000 },
			};

			const remote = {
				field1: { value: "remote1", lastModified: 1500 },
				field2: { value: "remote2", lastModified: 1000 },
			};

			const merged = (recovery as any).mergeStateUpdates(local, remote);

			expect(merged.field1.value).toBe("remote1"); // Remote is newer
			expect(merged.field2.value).toBe("local2"); // Local is newer
		});

		test("should handle user action conflicts with local wins strategy", async () => {
			const originalProcessUserAction = (recovery as any).processUserAction;
			(recovery as any).processUserAction = async () => {
				return {
					success: false,
					conflict: true,
					conflictData: { remoteAction: "different" },
				};
			};

			recovery.queueOperation({
				type: "user_action",
				data: { action: "local_action" },
				priority: "high",
				timestamp: Date.now(),
				maxRetries: 3,
				expiresAt: Date.now() + 60000,
			});

			const result = await recovery.processOfflineQueue();

			expect(result.conflicts).toBe(1);

			// Restore original method
			(recovery as any).processUserAction = originalProcessUserAction;
		});
	});

	describe("Memory and Performance", () => {
		test("should track memory usage accurately", () => {
			const initialMemory = recovery.getQueueMemoryUsage();

			recovery.queueOperation({
				type: "message",
				data: {
					text: "test message with some content to increase memory usage",
				},
				priority: "medium",
				timestamp: Date.now(),
				maxRetries: 3,
				expiresAt: Date.now() + 60000,
			});

			const afterMemory = recovery.getQueueMemoryUsage();
			expect(afterMemory).toBeGreaterThan(initialMemory);
		});

		test("should estimate processing time based on queue content", () => {
			// Add operations with different priorities
			recovery.queueOperation({
				type: "message",
				data: { text: "critical" },
				priority: "critical",
				timestamp: Date.now(),
				maxRetries: 3,
				expiresAt: Date.now() + 60000,
			});

			recovery.queueOperation({
				type: "message",
				data: { text: "low" },
				priority: "low",
				timestamp: Date.now(),
				maxRetries: 3,
				expiresAt: Date.now() + 60000,
			});

			const status = recovery.getQueueStatus();
			expect(status.estimatedProcessingTime).toBeGreaterThan(0);
		});

		test("should handle large queues efficiently", () => {
			const startTime = Date.now();
			const numOperations = 100;

			for (let i = 0; i < numOperations; i++) {
				recovery.queueOperation({
					type: "message",
					data: { text: `message ${i}` },
					priority: i % 2 === 0 ? "high" : "low",
					timestamp: Date.now() + i,
					maxRetries: 3,
					expiresAt: Date.now() + 60000,
				});
			}

			const queueTime = Date.now() - startTime;
			expect(queueTime).toBeLessThan(1000); // Should queue 100 operations in less than 1 second
			expect(recovery.getQueueSize()).toBe(numOperations);
		});
	});

	describe("Queue Status and Monitoring", () => {
		test("should provide accurate queue status", () => {
			const now = Date.now();

			recovery.queueOperation({
				type: "message",
				data: { text: "critical" },
				priority: "critical",
				timestamp: now - 5000, // 5 seconds ago
				maxRetries: 3,
				expiresAt: now + 60000,
			});

			recovery.queueOperation({
				type: "message",
				data: { text: "medium" },
				priority: "medium",
				timestamp: now - 3000, // 3 seconds ago
				maxRetries: 3,
				expiresAt: now + 60000,
			});

			const status = recovery.getQueueStatus();

			expect(status.totalOperations).toBe(2);
			expect(status.byPriority.critical).toBe(1);
			expect(status.byPriority.medium).toBe(1);
			expect(status.oldestOperationAge).toBeGreaterThan(4000);
			expect(status.estimatedProcessingTime).toBeGreaterThan(0);
		});

		test("should handle empty queue status", () => {
			const status = recovery.getQueueStatus();

			expect(status.totalOperations).toBe(0);
			expect(status.byPriority.critical).toBe(0);
			expect(status.byPriority.high).toBe(0);
			expect(status.byPriority.medium).toBe(0);
			expect(status.byPriority.low).toBe(0);
			expect(status.estimatedProcessingTime).toBe(0);
		});
	});

	describe("Configuration Management", () => {
		test("should allow setting max queue size", () => {
			const newMaxSize = 500;
			recovery.setMaxQueueSize(newMaxSize);

			// Add operations up to the new limit
			for (let i = 0; i < newMaxSize + 10; i++) {
				recovery.queueOperation({
					type: "message",
					data: { text: `message ${i}` },
					priority: "low",
					timestamp: Date.now() + i,
					maxRetries: 3,
					expiresAt: Date.now() + 60000,
				});
			}

			expect(recovery.getQueueSize()).toBeLessThanOrEqual(newMaxSize);
		});

		test("should allow setting max offline time", () => {
			const newMaxTime = 12 * 60 * 60 * 1000; // 12 hours
			recovery.setMaxOfflineTime(newMaxTime);

			// This test verifies the setter works; expiration logic is tested elsewhere
			expect(() => recovery.setMaxOfflineTime(newMaxTime)).not.toThrow();
		});

		test("should clear queue when requested", () => {
			recovery.queueOperation({
				type: "message",
				data: { text: "test" },
				priority: "medium",
				timestamp: Date.now(),
				maxRetries: 3,
				expiresAt: Date.now() + 60000,
			});

			expect(recovery.getQueueSize()).toBe(1);

			recovery.clearQueue();

			expect(recovery.getQueueSize()).toBe(0);
		});
	});

	describe("Error Handling", () => {
		test("should handle unknown operation types", async () => {
			// Force an unknown operation type into the queue
			const unknownOp = {
				id: "test-unknown",
				type: "unknown_type" as any,
				data: { test: "data" },
				timestamp: Date.now(),
				priority: "medium" as const,
				retryCount: 0,
				maxRetries: 3,
				expiresAt: Date.now() + 60000,
			};

			(recovery as any).offlineQueue.push(unknownOp);

			const result = await recovery.processOfflineQueue();

			expect(result.errors.length).toBe(1);
			expect(result.errors[0].error).toContain("Unknown operation type");
		});

		test("should handle processing errors gracefully", async () => {
			const originalProcessMessage = (recovery as any).processMessage;
			(recovery as any).processMessage = async () => {
				throw new Error("Processing error");
			};

			recovery.queueOperation({
				type: "message",
				data: { text: "error test" },
				priority: "medium",
				timestamp: Date.now(),
				maxRetries: 3,
				expiresAt: Date.now() + 60000,
			});

			const result = await recovery.processOfflineQueue();

			expect(result.errors.length).toBe(1);
			expect(result.errors[0].error).toBe("Processing error");

			// Restore original method
			(recovery as any).processMessage = originalProcessMessage;
		});
	});

	describe("Cleanup and Resource Management", () => {
		test("should properly destroy and cleanup resources", () => {
			const recovery2 = new EnhancedSessionRecovery();

			recovery2.queueOperation({
				type: "message",
				data: { text: "test" },
				priority: "medium",
				timestamp: Date.now(),
				maxRetries: 3,
				expiresAt: Date.now() + 60000,
			});

			expect(recovery2.getQueueSize()).toBe(1);

			recovery2.destroy();

			expect(recovery2.getQueueSize()).toBe(0);
		});

		test("should handle multiple destroy calls safely", () => {
			const recovery2 = new EnhancedSessionRecovery();

			expect(() => {
				recovery2.destroy();
				recovery2.destroy();
			}).not.toThrow();
		});
	});
});
