/**
 * Connection timeout handling with exponential backoff and retry logic
 * Provides robust network request handling with configurable timeouts and retries
 */

export interface ConnectionTimeoutConfig {
  defaultTimeout: number;         // Default request timeout (ms)
  maxRetries: number;            // Maximum retry attempts
  baseDelay: number;            // Base delay for exponential backoff (ms)
  maxDelay: number;             // Maximum delay between retries (ms)
  retryMultiplier: number;      // Multiplier for exponential backoff
  retryableStatuses: number[];  // HTTP status codes that should trigger retries
}

const DEFAULT_CONFIG: ConnectionTimeoutConfig = {
  defaultTimeout: 30000,         // 30 seconds
  maxRetries: 3,
  baseDelay: 1000,              // 1 second
  maxDelay: 10000,              // 10 seconds
  retryMultiplier: 2,
  retryableStatuses: [408, 429, 500, 502, 503, 504] // Request timeout, rate limit, server errors
};

export interface RequestOptions extends RequestInit {
  timeout?: number;
  retries?: number;
  skipRetry?: boolean;
}

export interface TimeoutError extends Error {
  name: 'TimeoutError';
  timeout: number;
  attempt: number;
}

export interface RetryableError extends Error {
  name: 'RetryableError';
  attempt: number;
  maxRetries: number;
  originalError: Error;
}

export class ConnectionTimeoutHandler {
  private config: ConnectionTimeoutConfig;

  constructor(config: Partial<ConnectionTimeoutConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Make a request with timeout and retry logic
   */
  async requestWithTimeout<T = any>(
    url: string,
    options: RequestOptions = {}
  ): Promise<T> {
    const {
      timeout = this.config.defaultTimeout,
      retries = this.config.maxRetries,
      skipRetry = false,
      ...fetchOptions
    } = options;

    let lastError: Error;
    const maxAttempts = skipRetry ? 1 : retries + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.log(`🌐 ConnectionTimeoutHandler: Request attempt ${attempt}/${maxAttempts} to ${url}`);

        const response = await this.makeRequestWithTimeout(url, fetchOptions, timeout, attempt);

        // Check if response status indicates we should retry
        if (this.shouldRetryStatus(response.status) && attempt < maxAttempts) {
          const delay = this.calculateDelay(attempt);
          console.warn(`🌐 ConnectionTimeoutHandler: Retrying after ${delay}ms due to status ${response.status}`);
          await this.sleep(delay);
          continue;
        }

        // Parse response
        if (response.ok) {
          return await this.parseResponse<T>(response);
        } else {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

      } catch (error) {
        lastError = error as Error;

        // Don't retry if explicitly disabled
        if (skipRetry) {
          throw error;
        }

        // Don't retry on final attempt
        if (attempt === maxAttempts) {
          // Create a RetryableError with context
          const retryableError: RetryableError = Object.assign(
            new Error(`Request failed after ${maxAttempts} attempts: ${lastError.message}`),
            {
              name: 'RetryableError' as const,
              attempt,
              maxRetries: retries,
              originalError: lastError
            }
          );
          throw retryableError;
        }

        // Calculate delay for next attempt
        const delay = this.calculateDelay(attempt);
        console.warn(`🌐 ConnectionTimeoutHandler: Request failed (attempt ${attempt}), retrying in ${delay}ms:`, error instanceof Error ? error.message : String(error));
        await this.sleep(delay);
      }
    }

    // This should never be reached, but TypeScript needs it
    throw lastError!;
  }

  /**
   * Make a single request with timeout
   */
  private async makeRequestWithTimeout(
    url: string,
    options: RequestInit,
    timeout: number,
    attempt: number
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      return response;

    } catch (error) {
      clearTimeout(timeoutId);

      // Handle abort/timeout errors
      if (error instanceof Error) {
        if (error.name === 'AbortError' || error.message.includes('aborted')) {
          const timeoutError: TimeoutError = Object.assign(
            new Error(`Request timeout after ${timeout}ms`),
            {
              name: 'TimeoutError' as const,
              timeout,
              attempt
            }
          );
          throw timeoutError;
        }
      }

      throw error;
    }
  }

  /**
   * Parse response based on content type
   */
  private async parseResponse<T>(response: Response): Promise<T> {
    const contentType = response.headers.get('content-type') || '';

    try {
      if (contentType.includes('application/json')) {
        return await response.json();
      } else if (contentType.includes('text/')) {
        return await response.text() as unknown as T;
      } else {
        // For binary data or unknown types
        return await response.blob() as unknown as T;
      }
    } catch (parseError) {
      throw new Error(`Failed to parse response: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`);
    }
  }

  /**
   * Check if a status code should trigger a retry
   */
  private shouldRetryStatus(status: number): boolean {
    return this.config.retryableStatuses.includes(status);
  }

  /**
   * Calculate delay for exponential backoff
   */
  private calculateDelay(attempt: number): number {
    const exponentialDelay = this.config.baseDelay * Math.pow(this.config.retryMultiplier, attempt - 1);

    // Add jitter to prevent thundering herd
    const jitter = Math.random() * 0.1 * exponentialDelay;

    // Cap at maximum delay
    return Math.min(exponentialDelay + jitter, this.config.maxDelay);
  }

  /**
   * Sleep for specified duration
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<ConnectionTimeoutConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Get current configuration
   */
  getConfig(): ConnectionTimeoutConfig {
    return { ...this.config };
  }

  /**
   * Create a request function with pre-configured options
   */
  createRequestFunction(baseOptions: RequestOptions = {}) {
    return <T = any>(url: string, options: RequestOptions = {}): Promise<T> => {
      const mergedOptions = { ...baseOptions, ...options };
      return this.requestWithTimeout<T>(url, mergedOptions);
    };
  }

  /**
   * Get statistics about request performance
   */
  getStatistics(): {
    config: ConnectionTimeoutConfig;
  } {
    return {
      config: { ...this.config }
    };
  }
}

// Utility functions for common timeout scenarios

/**
 * Create a timeout handler for API requests
 */
export function createApiTimeoutHandler(config?: Partial<ConnectionTimeoutConfig>): ConnectionTimeoutHandler {
  return new ConnectionTimeoutHandler({
    defaultTimeout: 15000,  // 15 seconds for API calls
    maxRetries: 2,
    baseDelay: 500,        // Faster retry for API calls
    ...config
  });
}

/**
 * Create a timeout handler for file uploads
 */
export function createUploadTimeoutHandler(config?: Partial<ConnectionTimeoutConfig>): ConnectionTimeoutHandler {
  return new ConnectionTimeoutHandler({
    defaultTimeout: 60000,  // 60 seconds for uploads
    maxRetries: 1,         // Less retries for uploads
    baseDelay: 2000,       // Longer delay between upload retries
    ...config
  });
}

/**
 * Create a timeout handler for critical operations
 */
export function createCriticalTimeoutHandler(config?: Partial<ConnectionTimeoutConfig>): ConnectionTimeoutHandler {
  return new ConnectionTimeoutHandler({
    defaultTimeout: 45000,  // 45 seconds for critical ops
    maxRetries: 5,         // More retries for critical operations
    baseDelay: 1000,
    maxDelay: 15000,       // Allow longer delays for critical ops
    ...config
  });
}

// Global singleton instance for general use
export const connectionTimeoutHandler = new ConnectionTimeoutHandler();

/**
 * Convenience function for making requests with timeout
 */
export function requestWithTimeout<T = any>(
  url: string,
  options: RequestOptions = {}
): Promise<T> {
  return connectionTimeoutHandler.requestWithTimeout<T>(url, options);
}

/**
 * Type guards for error types
 */
export function isTimeoutError(error: unknown): error is TimeoutError {
  return error instanceof Error && error.name === 'TimeoutError';
}

export function isRetryableError(error: unknown): error is RetryableError {
  return error instanceof Error && error.name === 'RetryableError';
}