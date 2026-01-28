import open from 'open';
import { logger } from '@/ui/logger';

/**
 * Attempts to open a URL in the default browser
 * 
 * @param url - The URL to open
 * @returns Promise<boolean> - true if successful, false if failed or in headless environment
 */
export async function openBrowser(url: string): Promise<boolean> {
    try {
        // Check if we're in a headless environment
        if (!process.stdout.isTTY || process.env.CI || process.env.HEADLESS) {
            logger.debug('[browser] Headless environment detected, skipping browser open');
            return false;
        }

        logger.debug(`[browser] Attempting to open URL: ${url}`);
        await open(url);
        logger.debug('[browser] Browser opened successfully');
        return true;
    } catch (error) {
        logger.debug('[browser] Failed to open browser:', error);
        return false;
    }
}