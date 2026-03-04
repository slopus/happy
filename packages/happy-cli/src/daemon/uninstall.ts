import { logger } from '@/ui/logger';
import { uninstall as uninstallMac } from './mac/uninstall';
import { uninstall as uninstallLinux } from './linux/uninstall';
import { stopDaemon } from './controlClient';

export async function uninstall(): Promise<void> {
    if (process.platform === 'darwin') {
        logger.info('Removing daemon auto-start for macOS...');
        await uninstallMac();
    } else if (process.platform === 'linux') {
        logger.info('Removing daemon auto-start for Linux...');
        await uninstallLinux();
    } else {
        throw new Error(`Unsupported platform: ${process.platform}. Only macOS and Linux are supported.`);
    }

    // Also stop the running daemon if any
    try {
        await stopDaemon();
    } catch {
        // Daemon might not be running
    }
}
