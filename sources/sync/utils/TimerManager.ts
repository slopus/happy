/**
 * Common timer management utilities
 * Reduces code duplication for timer and interval management across the codebase
 */

import { log } from '@/log';

export interface TimerOptions {
  name?: string;
  onError?: (error: Error) => void;
}

export class TimerManager {
  private timers = new Map<string, NodeJS.Timeout>();
  private intervals = new Map<string, NodeJS.Timeout>();
  private source: string;

  constructor(source: string) {
    this.source = source;
  }

  /**
   * Set a timeout with automatic cleanup
   */
  setTimeout(
    callback: () => void,
    delay: number,
    id: string,
    options?: TimerOptions
  ): NodeJS.Timeout {
    // Clear existing timer with same ID
    this.clearTimeout(id);

    const wrappedCallback = () => {
      try {
        callback();
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        log.error(
          `Timer callback error for ${id}`,
          this.source,
          err
        );
        
        if (options?.onError) {
          options.onError(err);
        }
      } finally {
        // Automatic cleanup
        this.timers.delete(id);
      }
    };

    const timer = setTimeout(wrappedCallback, delay);
    this.timers.set(id, timer);
    
    if (options?.name) {
      log.debug(`Set timeout '${options.name}' (${id}) for ${delay}ms`, this.source);
    }

    return timer;
  }

  /**
   * Set an interval with automatic error handling
   */
  setInterval(
    callback: () => void,
    interval: number,
    id: string,
    options?: TimerOptions
  ): NodeJS.Timeout {
    // Clear existing interval with same ID
    this.clearInterval(id);

    const wrappedCallback = () => {
      try {
        callback();
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        log.error(
          `Interval callback error for ${id}`,
          this.source,
          err
        );
        
        if (options?.onError) {
          options.onError(err);
        }
      }
    };

    const timer = setInterval(wrappedCallback, interval);
    this.intervals.set(id, timer);
    
    if (options?.name) {
      log.debug(`Set interval '${options.name}' (${id}) for ${interval}ms`, this.source);
    }

    return timer;
  }

  /**
   * Clear a specific timeout
   */
  clearTimeout(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
      log.debug(`Cleared timeout ${id}`, this.source);
    }
  }

  /**
   * Clear a specific interval
   */
  clearInterval(id: string): void {
    const timer = this.intervals.get(id);
    if (timer) {
      clearInterval(timer);
      this.intervals.delete(id);
      log.debug(`Cleared interval ${id}`, this.source);
    }
  }

  /**
   * Clear all timers and intervals
   */
  clearAll(): void {
    for (const [id] of this.timers) {
      this.clearTimeout(id);
    }
    
    for (const [id] of this.intervals) {
      this.clearInterval(id);
    }

    log.debug('Cleared all timers', this.source);
  }

  /**
   * Get active timer count for monitoring
   */
  getActiveCount(): { timeouts: number; intervals: number } {
    return {
      timeouts: this.timers.size,
      intervals: this.intervals.size
    };
  }

  /**
   * Get list of active timer IDs for debugging
   */
  getActiveIds(): { timeouts: string[]; intervals: string[] } {
    return {
      timeouts: Array.from(this.timers.keys()),
      intervals: Array.from(this.intervals.keys())
    };
  }

  /**
   * Check if a specific timer exists
   */
  hasTimeout(id: string): boolean {
    return this.timers.has(id);
  }

  /**
   * Check if a specific interval exists
   */
  hasInterval(id: string): boolean {
    return this.intervals.has(id);
  }

  /**
   * Restart an interval (clear and set again)
   */
  restartInterval(
    callback: () => void,
    interval: number,
    id: string,
    options?: TimerOptions
  ): NodeJS.Timeout {
    this.clearInterval(id);
    return this.setInterval(callback, interval, id, options);
  }

  /**
   * Reschedule a timeout (clear and set again)
   */
  rescheduleTimeout(
    callback: () => void,
    delay: number,
    id: string,
    options?: TimerOptions
  ): NodeJS.Timeout {
    this.clearTimeout(id);
    return this.setTimeout(callback, delay, id, options);
  }
}

/**
 * Global timer manager for shared timers
 */
export const globalTimerManager = new TimerManager('Global');

/**
 * Utility functions for common timer patterns
 */
export class TimerUtils {
  /**
   * Create a debounced function that delays execution
   */
  static debounce<T extends (...args: any[]) => void>(
    func: T,
    delay: number,
    timerManager: TimerManager,
    id: string
  ): T {
    return ((...args: any[]) => {
      timerManager.setTimeout(() => func(...args), delay, `debounce_${id}`);
    }) as T;
  }

  /**
   * Create a throttled function that limits execution rate
   */
  static throttle<T extends (...args: any[]) => void>(
    func: T,
    delay: number
  ): T {
    let lastExecution = 0;
    
    return ((...args: any[]) => {
      const now = Date.now();
      
      if (now - lastExecution >= delay) {
        lastExecution = now;
        func(...args);
      }
    }) as T;
  }

  /**
   * Create a function that executes after a delay, with automatic cancellation
   */
  static delayed<T extends (...args: any[]) => void>(
    func: T,
    delay: number,
    timerManager: TimerManager,
    id: string
  ): { execute: T; cancel: () => void } {
    return {
      execute: ((...args: any[]) => {
        timerManager.setTimeout(() => func(...args), delay, `delayed_${id}`);
      }) as T,
      cancel: () => timerManager.clearTimeout(`delayed_${id}`)
    };
  }

  /**
   * Execute a callback with exponential backoff retry logic
   */
  static async withBackoff<T>(
    operation: () => Promise<T>,
    options: {
      maxRetries: number;
      baseDelay: number;
      backoffMultiplier?: number;
      jitter?: boolean;
      onRetry?: (attempt: number, delay: number) => void;
    }
  ): Promise<T> {
    const {
      maxRetries,
      baseDelay,
      backoffMultiplier = 2,
      jitter = true,
      onRetry
    } = options;
    
    let lastError: Error;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        if (attempt === maxRetries) {
          break;
        }

        // Calculate delay with exponential backoff
        let delay = baseDelay * Math.pow(backoffMultiplier, attempt);
        
        // Add jitter to prevent thundering herd
        if (jitter) {
          delay *= (0.5 + Math.random() * 0.5);
        }

        if (onRetry) {
          onRetry(attempt + 1, delay);
        }

        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    throw lastError!;
  }
}