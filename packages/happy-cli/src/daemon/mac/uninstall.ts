import { existsSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import os from 'os';
import { logger } from '@/ui/logger';

const PLIST_LABEL = 'com.happy-cli.daemon';
const PLIST_PATH = join(os.homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);

export async function uninstall(): Promise<void> {
    if (!existsSync(PLIST_PATH)) {
        logger.info('No LaunchAgent found. Auto-start is not enabled.');
        return;
    }

    try {
        execSync(`launchctl unload ${PLIST_PATH}`, { stdio: 'ignore' });
    } catch {
        // May not be loaded — safe to ignore
    }

    unlinkSync(PLIST_PATH);
    logger.info('Daemon auto-start disabled.');
}
