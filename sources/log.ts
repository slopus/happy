/**
 * Enhanced logging mechanism with proper logging levels
 * Supports debug, info, warn, error levels with production filtering
 * Keeps last 5k records in memory with change notifications for UI updates
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: number;
  level: LogLevel;
  message: string;
  source?: string;
}

class Logger {
  private logs: LogEntry[] = [];
  private maxLogs = 5000;
  private listeners: Array<() => void> = [];
  private logLevel: LogLevel = (typeof __DEV__ !== 'undefined' && __DEV__) ? 'debug' : 'warn'; // Only warn/error in production

  private shouldLog(level: LogLevel): boolean {
    const levels: Record<LogLevel, number> = {
      debug: 0,
      info: 1, 
      warn: 2,
      error: 3
    };
    return levels[level] >= levels[this.logLevel];
  }

  private addLog(level: LogLevel, message: string, source?: string): void {
    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      message,
      source
    };

    this.logs.push(entry);

    // Maintain 5k limit with circular buffer
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    // Notify listeners for real-time updates
    this.listeners.forEach(listener => listener());
  }

  /**
   * Log a debug message - only in development
   */
  debug(message: string, source?: string): void {
    if (!this.shouldLog('debug')) return;
    this.addLog('debug', message, source);
    console.log(`[DEBUG] ${source ? `[${source}]` : ''} ${message}`);
  }

  /**
   * Log an info message
   */
  info(message: string, source?: string): void {
    if (!this.shouldLog('info')) return;
    this.addLog('info', message, source);
    console.info(`[INFO] ${source ? `[${source}]` : ''} ${message}`);
  }

  /**
   * Log a warning message
   */
  warn(message: string, source?: string): void {
    if (!this.shouldLog('warn')) return;
    this.addLog('warn', message, source);
    console.warn(`[WARN] ${source ? `[${source}]` : ''} ${message}`);
  }

  /**
   * Log an error message
   */
  error(message: string, source?: string, error?: Error): void {
    if (!this.shouldLog('error')) return;
    const fullMessage = error ? `${message}: ${error.message}` : message;
    this.addLog('error', fullMessage, source);
    console.error(`[ERROR] ${source ? `[${source}]` : ''} ${fullMessage}`);
    if (error && __DEV__) {
      console.error(error.stack);
    }
  }

  /**
   * Legacy log method for backward compatibility
   */
  log(message: string, source?: string): void {
    this.info(message, source);
  }

  /**
   * Get all logs as a copy of the array
   */
  getLogs(): LogEntry[] {
    return [...this.logs];
  }

  /**
   * Get logs as formatted strings (backward compatibility)
   */
  getLogsAsStrings(): string[] {
    return this.logs.map(entry => {
      const timestamp = new Date(entry.timestamp).toLocaleTimeString();
      const source = entry.source ? `[${entry.source}]` : '';
      return `${timestamp} [${entry.level.toUpperCase()}] ${source} ${entry.message}`;
    });
  }

  /**
     * Clear all logs
     */
  clear(): void {
    this.logs = [];
    this.listeners.forEach(listener => listener());
  }

  /**
     * Subscribe to log changes - returns unsubscribe function
     */
  onChange(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index > -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  /**
   * Get current number of logs
   */
  getCount(): number {
    return this.logs.length;
  }

  /**
   * Set log level
   */
  setLogLevel(level: LogLevel): void {
    this.logLevel = level;
  }

  /**
   * Get current log level
   */
  getLogLevel(): LogLevel {
    return this.logLevel;
  }
}

// Export singleton instance
export const log = new Logger();