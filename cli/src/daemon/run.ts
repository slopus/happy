import { ApiDaemonSession } from '@/api/apiDaemonSession'
import { MachineIdentity } from '@/api/daemonTypes'
import { logger } from '@/ui/logger'
import { readSettings, writeSettings, readCredentials } from '@/persistence/persistence'
import { hostname } from 'os'
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { doAuth } from '@/ui/auth'
import crypto from 'crypto'

const DAEMON_PID_FILE = join(homedir(), '.happy', 'daemon-pid');

export async function startDaemon(): Promise<void> {
    if (isDaemonRunning()) {
        console.log('Happy daemon is already running');
        process.exit(0);
    }

    logger.info('Happy CLI daemon started successfully');

    // Write PID file
    writePidFile();

    // Setup cleanup handlers
    process.on('SIGINT', stopDaemon);
    process.on('SIGTERM', stopDaemon);
    process.on('exit', stopDaemon);

    try {
        // Load or create machine identity
        const settings = await readSettings() || { onboardingCompleted: false };
        if (!settings.machineId) {
            // Generate a UUID for machine ID
            settings.machineId = crypto.randomUUID();
            settings.machineHost = hostname();
            await writeSettings(settings);
        }

        const machineIdentity: MachineIdentity = {
            machineId: settings.machineId!,
            machineHost: settings.machineHost || hostname(),
            platform: process.platform,
            version: process.env.npm_package_version || 'unknown'
        };

        // Get auth token and secret
        let credentials = await readCredentials();
        if (!credentials) {
            logger.debug('[DAEMON] No credentials found, running auth');
            await doAuth();
            credentials = await readCredentials();
            if (!credentials) {
                throw new Error('Failed to authenticate');
            }
        }

        const { token, secret } = credentials;

        // Create daemon session
        const daemon = new ApiDaemonSession(token, secret, machineIdentity);

        daemon.on('connected', () => {
            logger.debug('[DAEMON] Successfully connected to server');
        });

        daemon.on('disconnected', () => {
            logger.debug('[DAEMON] Disconnected from server');
        });

        daemon.on('shutdown', () => {
            logger.debug('[DAEMON] Shutdown requested');
            stopDaemon();
            process.exit(0);
        });

        // Connect to server
        daemon.connect();

        // Keep process alive
        setInterval(() => {}, 1000);

    } catch (error) {
        logger.debug('[DAEMON] Failed to start daemon', error);
        stopDaemon();
        process.exit(1);
    }

    // Register signal handlers
    process.on('SIGINT', () => process.exit(0));
    process.on('SIGTERM', () => process.exit(0));
    process.on('exit', () => process.exit(0));

    // Keep process alive
    while (true) {
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

export function isDaemonRunning(): boolean {
    try {
        if (!existsSync(DAEMON_PID_FILE)) {
            console.log('No PID file found');
            return false;
        }
        
        const pid = parseInt(readFileSync(DAEMON_PID_FILE, 'utf-8'));
        
        // Just check if process exists, don't kill
        try {
            process.kill(pid, 0);
            return true;
        } catch (error) {
            console.log('Process not running', error);
            // Process not running, clean up stale PID file
            unlinkSync(DAEMON_PID_FILE);
            return false;
        }
    } catch {
        return false;
    }
}

function writePidFile() {
    const happyDir = join(homedir(), '.happy');
    if (!existsSync(happyDir)) {
        mkdirSync(happyDir, { recursive: true });
    }
    writeFileSync(DAEMON_PID_FILE, process.pid.toString());
}

export function stopDaemon() {
    try {
        if (existsSync(DAEMON_PID_FILE)) {
            logger.debug('[DAEMON] Stopping daemon');
            process.kill(parseInt(readFileSync(DAEMON_PID_FILE, 'utf-8')), 'SIGTERM');
            unlinkSync(DAEMON_PID_FILE);
        }
    } catch (error) {
        logger.debug('[DAEMON] Error cleaning up PID file', error);
    }
}