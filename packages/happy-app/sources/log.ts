/**
 * Simple logging mechanism that writes to console and maintains internal array
 * Keeps last 5k records in memory with change notifications for UI updates
 */
type ConsoleLogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';
export const MAX_APP_LOG_ENTRIES = 5000;

class Logger {
    private logs: string[] = [];
    private maxLogs = MAX_APP_LOG_ENTRIES;
    private listeners: Array<() => void> = [];
    private consoleCaptureEnabled = false;

    private append(message: string): void {
        this.logs.push(message);

        // Maintain 5k limit with circular buffer
        if (this.logs.length > this.maxLogs) {
            this.logs.shift();
        }

        // Notify listeners for real-time updates
        this.listeners.forEach(listener => listener());
    }

    private formatValue(value: unknown): string {
        if (typeof value === 'string') {
            return value;
        }

        try {
            const serialized = JSON.stringify(value, null, 2);
            return serialized ?? String(value);
        } catch {
            return String(value);
        }
    }

    private formatConsoleMessage(level: ConsoleLogLevel, args: unknown[]): string {
        const message = args.map(arg => this.formatValue(arg)).join('\n');
        if (level === 'log') {
            return message;
        }
        return `[${level}] ${message}`;
    }

    setConsoleCaptureEnabled(enabled: boolean): void {
        this.consoleCaptureEnabled = enabled;
    }

    captureConsole(level: ConsoleLogLevel, args: unknown[]): void {
        this.append(this.formatConsoleMessage(level, args));
    }

    /**
     * Capture a pre-formatted message (avoids double serialization)
     */
    captureFormatted(level: ConsoleLogLevel, formatted: string): void {
        const message = level === 'log' ? formatted : `[${level}] ${formatted}`;
        this.append(message);
    }

    /**
     * Log a message - writes to both console and internal array
     */
    log(message: string): void {
        if (!this.consoleCaptureEnabled) {
            this.append(message);
        }

        console.log(message);
    }

    /**
     * Get all logs as a copy of the array
     */
    getLogs(): string[] {
        return [...this.logs];
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

    getMaxLogs(): number {
        return this.maxLogs;
    }
}

// Export singleton instance
export const log = new Logger();
