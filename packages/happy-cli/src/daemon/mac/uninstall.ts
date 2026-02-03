/**
 * Uninstallation script for Happy daemon LaunchDaemon
 * 
 * NOTE: This uninstallation method is currently NOT USED since we moved away from
 * system-level daemon installation. See install.ts for the full explanation.
 * 
 * This code is kept for potential future use if we decide to offer system-level 
 * installation/uninstallation as an option.
 */

import { existsSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { logger } from '@/ui/logger';

const PLIST_LABEL = 'com.happy-cli.daemon';
const PLIST_FILE = `/Library/LaunchDaemons/${PLIST_LABEL}.plist`;

export async function uninstall(): Promise<void> {
    try {
        // Check if plist exists
        if (!existsSync(PLIST_FILE)) {
            logger.info('Daemon plist not found. Nothing to uninstall.');
            return;
        }
        
        // Unload the daemon
        try {
            execSync(`launchctl unload ${PLIST_FILE}`, { stdio: 'inherit' });
            logger.info('Daemon stopped successfully');
        } catch (error) {
            // Daemon might not be loaded, continue with removal
            logger.info('Failed to unload daemon (it might not be running)');
        }
        
        // Remove the plist file
        unlinkSync(PLIST_FILE);
        logger.info(`Removed daemon plist from ${PLIST_FILE}`);
        
        logger.info('Daemon uninstalled successfully');
        
    } catch (error) {
        logger.debug('Failed to uninstall daemon:', error);
        throw error;
    }
}