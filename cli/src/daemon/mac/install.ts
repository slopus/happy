import { writeFileSync, chmodSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { logger } from '@/ui/logger';
import { trimIdent } from '@/utils/trimIdent';

const PLIST_LABEL = 'com.happy-cli.daemon';
const PLIST_FILE = `/Library/LaunchDaemons/${PLIST_LABEL}.plist`;

export async function install(): Promise<void> {
    try {
        // Check if already installed
        if (existsSync(PLIST_FILE)) {
            logger.info('Daemon plist already exists. Uninstalling first...');
            execSync(`launchctl unload ${PLIST_FILE}`, { stdio: 'inherit' });
        }
        
        // Get the path to the happy CLI executable
        const happyPath = process.argv[0]; // Node.js executable
        const scriptPath = process.argv[1]; // Script path
        
        // Create plist content
        const plistContent = trimIdent(`
            <?xml version="1.0" encoding="UTF-8"?>
            <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
            <plist version="1.0">
            <dict>
                <key>Label</key>
                <string>${PLIST_LABEL}</string>
                
                <key>ProgramArguments</key>
                <array>
                    <string>${happyPath}</string>
                    <string>${scriptPath}</string>
                    <string>daemon</string>
                </array>
                
                <key>EnvironmentVariables</key>
                <dict>
                    <key>HAPPY_DAEMON_MODE</key>
                    <string>true</string>
                </dict>
                
                <key>RunAtLoad</key>
                <true/>
                
                <key>KeepAlive</key>
                <true/>
                
                <key>StandardErrorPath</key>
                <string>/var/log/happy-cli-daemon.err</string>
                
                <key>StandardOutPath</key>
                <string>/var/log/happy-cli-daemon.log</string>
                
                <key>WorkingDirectory</key>
                <string>/tmp</string>
            </dict>
            </plist>
        `);
        
        // Write plist file
        writeFileSync(PLIST_FILE, plistContent);
        chmodSync(PLIST_FILE, 0o644);
        
        logger.info(`Created daemon plist at ${PLIST_FILE}`);
        
        // Load the daemon
        execSync(`launchctl load ${PLIST_FILE}`, { stdio: 'inherit' });
        
        logger.info('Daemon installed and started successfully');
        logger.info('Check logs at /var/log/happy-cli-daemon.log');
        
    } catch (error) {
        logger.debug('Failed to install daemon:', error);
        throw error;
    }
}