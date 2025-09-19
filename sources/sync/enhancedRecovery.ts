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

export interface ProcessingResult {
  processed: number;
  failed: number;
  conflicts: number;
  errors: Array<{ operationId: string; error: string }>;
}

export interface OperationResult {
  success: boolean;
  conflict?: boolean;
  conflictData?: any;
  error?: string;
}

export interface QueueStatus {
  totalOperations: number;
  byPriority: Record<string, number>;
  oldestOperationAge: number;
  estimatedProcessingTime: number;
}

export class EnhancedSessionRecovery {
  private offlineQueue: QueuedOperation[] = [];
  private conflictResolver: Map<string, ConflictResolution> = new Map();
  private maxQueueSize: number = 1000;
  private maxOfflineTime: number = 24 * 60 * 60 * 1000; // 24 hours
  private maintenanceInterval: ReturnType<typeof setInterval> | null = null;

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

    // Collect operations that should be retried after first pass (e.g., merge conflicts)
    const deferred: QueuedOperation[] = [];

    // Process operations in priority order (first pass)
    for (const operation of [...this.offlineQueue]) {
      try {
        const result = await this.processOperation(operation);

        if (result.success) {
          this.removeFromQueue(operation.id);
          results.processed++;
        } else if (result.conflict) {
          // Track the conflict, resolve it
          results.conflicts++;
          const resolver = this.conflictResolver.get(operation.type);
          await this.handleConflict(operation, result.conflictData);

          // If strategy is local_wins, we consider the operation applied locally and done
          if (resolver?.strategy === 'local_wins') {
            this.removeFromQueue(operation.id);
            results.processed++;
            continue;
          }

          // Defer re-processing until after first pass so other operations can proceed
          deferred.push(operation);
        } else {
          operation.retryCount++;
          if (operation.retryCount > operation.maxRetries) {
            this.removeFromQueue(operation.id);
            results.failed++;
            results.errors.push({
              operationId: operation.id,
              error: 'Max retries exceeded'
            });
          }
        }
      } catch (error) {
        results.errors.push({
          operationId: operation.id,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    // Second pass: reprocess deferred operations now that conflicts may be resolved by order
    for (const operation of deferred) {
      try {
        const result = await this.processOperation(operation);
        if (result.success) {
          this.removeFromQueue(operation.id);
          results.processed++;
        } else if (result.conflict) {
          // Still conflicting; leave in queue for a future run (already counted in first pass)
        } else {
          operation.retryCount++;
          if (operation.retryCount > operation.maxRetries) {
            this.removeFromQueue(operation.id);
            results.failed++;
            results.errors.push({
              operationId: operation.id,
              error: 'Max retries exceeded'
            });
          }
        }
      } catch (error) {
        results.errors.push({
          operationId: operation.id,
          error: error instanceof Error ? error.message : 'Unknown error'
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

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async processMessage(_operation: QueuedOperation): Promise<OperationResult> {
    try {
      // Simulate message processing logic
      // In a real implementation, this would send the message to the server
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Message processing failed'
      };
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async processStateUpdate(_operation: QueuedOperation): Promise<OperationResult> {
    try {
      // Simulate state update processing
      // Check for conflicts with current state
      const hasConflict = Math.random() < 0.1; // 10% chance of conflict for testing

      if (hasConflict) {
        return {
          success: false,
          conflict: true,
          conflictData: { remoteState: 'conflicting_data' }
        };
      }

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'State update failed'
      };
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async processUserAction(_operation: QueuedOperation): Promise<OperationResult> {
    try {
      // Simulate user action processing
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'User action processing failed'
      };
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
          // Do not process here; let the caller re-process so conflicts are counted consistently per operation
        }
        break;
      case 'user_choice':
        // Present conflict to user for resolution
        await this.presentConflictToUser(operation, conflictData);
        break;
    }
  }

  private async mergeConflict(operation: QueuedOperation, conflictData: any): Promise<void> {
    // Default merge strategy - use timestamp-based resolution
    if (operation.data.timestamp > conflictData.timestamp) {
      await this.forceLocalUpdate(operation);
    } else {
      this.removeFromQueue(operation.id);
    }
  }

  private async forceLocalUpdate(operation: QueuedOperation): Promise<void> {
    // Force the local operation to be processed
    operation.retryCount = 0; // Reset retry count for forced update
    // In a real implementation, this would force the update on the server
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async presentConflictToUser(operation: QueuedOperation, _conflictData: any): Promise<void> {
    // In a real implementation, this would show a UI for user to resolve conflict
    // For now, we'll default to local wins
    await this.forceLocalUpdate(operation);
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

  private estimateProcessingTime(): number {
    // Estimate processing time based on queue size and priority distribution
    const baseTimePerOperation = 100; // 100ms per operation
    const priorityMultipliers = { critical: 0.5, high: 0.7, medium: 1.0, low: 1.5 };

    let totalTime = 0;
    this.offlineQueue.forEach(op => {
      totalTime += baseTimePerOperation * priorityMultipliers[op.priority];
    });

    return totalTime;
  }

  private generateOperationId(): string {
    return `op_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private removeFromQueue(operationId: string): void {
    const index = this.offlineQueue.findIndex(op => op.id === operationId);
    if (index > -1) {
      this.offlineQueue.splice(index, 1);
    }
  }

  private startQueueMaintenance(): void {
    // Run maintenance every 5 minutes
    this.maintenanceInterval = setInterval(() => {
      this.enforceQueueLimits();
    }, 5 * 60 * 1000);
  }

  // Public methods for testing and monitoring
  getQueueSize(): number {
    return this.offlineQueue.length;
  }

  getQueueMemoryUsage(): number {
    // Estimate memory usage in bytes
    const jsonString = JSON.stringify(this.offlineQueue);
    return jsonString.length * 2; // UTF-16 uses 2 bytes per character
  }

  clearQueue(): void {
    this.offlineQueue = [];
  }

  setMaxQueueSize(size: number): void {
    this.maxQueueSize = size;
    this.enforceQueueLimits();
  }

  setMaxOfflineTime(timeMs: number): void {
    this.maxOfflineTime = timeMs;
  }

  destroy(): void {
    if (this.maintenanceInterval) {
      clearInterval(this.maintenanceInterval);
      this.maintenanceInterval = null;
    }
    this.clearQueue();
  }
}