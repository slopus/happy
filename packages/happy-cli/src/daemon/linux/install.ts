import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import os from 'os';
import { logger } from '@/ui/logger';
import { trimIdent } from '@/utils/trimIdent';
import { projectPath } from '@/projectPath';

const SERVICE_NAME = 'happy-daemon.service';

export async function install(): Promise<void> {
    const runtime = process.execPath;
    const entrypoint = path.join(projectPath(), 'dist', 'index.mjs');

    if (!existsSync(entrypoint)) {
        throw new Error(`Entrypoint not found: ${entrypoint}. Please build the project first.`);
    }

    const homedir = os.homedir();
    const serviceDir = path.join(homedir, '.config', 'systemd', 'user');
    const servicePath = path.join(serviceDir, SERVICE_NAME);

    const serviceContent = trimIdent(`
        [Unit]
        Description=Happy CLI Daemon
        After=network-online.target
        Wants=network-online.target

        [Service]
        Type=simple
        ExecStart=${runtime} --no-warnings --no-deprecation ${entrypoint} daemon start-sync
        Restart=on-failure
        RestartSec=30
        Environment=HOME=${homedir}

        [Install]
        WantedBy=default.target
    `);

    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(servicePath, serviceContent + '\n');

    logger.info(`Created systemd user service at ${servicePath}`);

    try {
        execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
        execSync(`systemctl --user enable --now ${SERVICE_NAME}`, { stdio: 'pipe' });
    } catch (error) {
        throw new Error('Failed to enable systemd service. Is systemd user session available? Try: systemctl --user status');
    }

    logger.info('Daemon enabled and started. It will auto-start on login.');
    logger.info('To disable: happy daemon disable');
}
