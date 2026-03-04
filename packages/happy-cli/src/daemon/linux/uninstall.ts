import { existsSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import os from 'os';
import { logger } from '@/ui/logger';

const SERVICE_NAME = 'happy-daemon.service';
const SERVICE_PATH = join(os.homedir(), '.config', 'systemd', 'user', SERVICE_NAME);

export async function uninstall(): Promise<void> {
    if (!existsSync(SERVICE_PATH)) {
        logger.info('No systemd service found. Auto-start is not enabled.');
        return;
    }

    try {
        execSync(`systemctl --user disable --now happy-daemon`, { stdio: 'ignore' });
    } catch {
        // May not be running — safe to ignore
    }

    unlinkSync(SERVICE_PATH);
    try {
        execSync('systemctl --user daemon-reload', { stdio: 'ignore' });
    } catch {
        // systemd user session may not be available (e.g. container)
    }
    logger.info('Daemon auto-start disabled.');
}
