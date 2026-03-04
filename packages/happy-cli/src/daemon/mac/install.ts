import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import os from 'os';
import { join } from 'path';
import { logger } from '@/ui/logger';
import { trimIdent } from '@/utils/trimIdent';
import { projectPath } from '@/projectPath';

const PLIST_LABEL = 'com.happy-cli.daemon';
const PLIST_DIR = join(os.homedir(), 'Library', 'LaunchAgents');
const PLIST_FILE = join(PLIST_DIR, `${PLIST_LABEL}.plist`);
const LOG_DIR = join(os.homedir(), '.happy');

export async function install(): Promise<void> {
    const runtime = process.execPath;
    const entrypoint = join(projectPath(), 'dist', 'index.mjs');

    // Ensure directories exist
    if (!existsSync(PLIST_DIR)) {
        mkdirSync(PLIST_DIR, { recursive: true });
    }
    if (!existsSync(LOG_DIR)) {
        mkdirSync(LOG_DIR, { recursive: true });
    }

    // If plist already exists, unload it first (ignore errors in case it wasn't loaded)
    if (existsSync(PLIST_FILE)) {
        logger.info('Daemon plist already exists. Unloading first...');
        try {
            execSync(`launchctl unload ${PLIST_FILE}`, { stdio: 'ignore' });
        } catch {
            // Ignore — may not be loaded
        }
    }

    const plistContent = trimIdent(`
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
            <key>Label</key>
            <string>${PLIST_LABEL}</string>

            <key>ProgramArguments</key>
            <array>
                <string>${runtime}</string>
                <string>--no-warnings</string>
                <string>--no-deprecation</string>
                <string>${entrypoint}</string>
                <string>daemon</string>
                <string>start-sync</string>
            </array>

            <key>RunAtLoad</key>
            <true/>

            <key>KeepAlive</key>
            <dict>
                <key>SuccessfulExit</key>
                <false/>
            </dict>

            <key>ThrottleInterval</key>
            <integer>30</integer>

            <key>StandardOutPath</key>
            <string>${join(os.homedir(), '.happy', 'daemon.log')}</string>

            <key>StandardErrorPath</key>
            <string>${join(os.homedir(), '.happy', 'daemon.err')}</string>

            <key>WorkingDirectory</key>
            <string>/tmp</string>
        </dict>
        </plist>
    `);

    writeFileSync(PLIST_FILE, plistContent);
    logger.info(`Created LaunchAgent plist at ${PLIST_FILE}`);

    try {
        execSync(`launchctl load ${PLIST_FILE}`, { stdio: 'pipe' });
    } catch (error) {
        throw new Error(`Failed to load LaunchAgent. You can try manually: launchctl load ${PLIST_FILE}`);
    }
    logger.info('Daemon enabled and started. It will auto-start on login.');
    logger.info('To disable: happy daemon disable');
}
