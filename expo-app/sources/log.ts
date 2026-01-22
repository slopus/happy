/**
 * Simple logging mechanism that writes to console and maintains internal array
 * Keeps last 5k records in memory with change notifications for UI updates
 */
class Logger {
    private logs: string[] = [];
    private maxLogs = 5000;
    private listeners: Array<() => void> = [];

    /**
     * Log a message - writes to both console and internal array
     */
    log(message: string): void {
        // Add to internal array
        this.logs.push(message);
        
        // Maintain 5k limit with circular buffer
        if (this.logs.length > this.maxLogs) {
            this.logs.shift();
        }
        
        // Write to console
        console.log(message);
        
        // Notify listeners for real-time updates
        this.listeners.forEach(listener => listener());
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
}

// Export singleton instance
export const log = new Logger();