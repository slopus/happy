import { logger } from '@/ui/logger';

/**
 * Manages Claude SDK interrupt functionality across the application.
 * Allows interruption to be triggered from start.ts while the actual
 * interrupt function is registered in claudeRemote.ts
 */
export class InterruptController {
    private interruptFn?: () => Promise<void>;
    private isInterrupting = false;
    
    /**
     * Register an interrupt function from claudeRemote
     */
    register(fn: () => Promise<void>) {
        this.interruptFn = fn;
    }
    
    /**
     * Unregister the interrupt function (cleanup)
     */
    unregister() {
        this.interruptFn = undefined;
        this.isInterrupting = false;
    }
    
    /**
     * Trigger the interrupt - can be called from anywhere
     */
    async interrupt(): Promise<boolean> {
        if (!this.interruptFn || this.isInterrupting) {
            return false;
        }
        
        this.isInterrupting = true;
        try {
            await this.interruptFn();
            return true;
        } catch (error) {
            logger.debug('Failed to interrupt Claude:', error);
            return false;
        } finally {
            this.isInterrupting = false;
        }
    }
    
    /**
     * Check if interrupt is available
     */
    canInterrupt(): boolean {
        return !!this.interruptFn && !this.isInterrupting;
    }
}