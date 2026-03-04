import { logger } from '@/ui/logger';
import { readCredentials } from '@/persistence';
import { install as installMac } from './mac/install';
import { install as installLinux } from './linux/install';

export async function install(): Promise<void> {
    const credentials = await readCredentials();
    if (!credentials) {
        throw new Error('Not authenticated. Please run "happy auth login" first.');
    }

    if (process.platform === 'darwin') {
        logger.info('Setting up daemon auto-start for macOS...');
        await installMac();
    } else if (process.platform === 'linux') {
        logger.info('Setting up daemon auto-start for Linux...');
        await installLinux();
    } else {
        throw new Error(`Unsupported platform: ${process.platform}. Only macOS and Linux are supported.`);
    }
}
