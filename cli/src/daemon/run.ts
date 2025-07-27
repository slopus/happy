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
import { spawn } from 'child_process'
import { configuration } from '@/configuration'

export async function startDaemon(): Promise<void> {
    console.log('[DAEMON] Starting daemon process...');
    
    if (await isDaemonRunning()) {
        console.log('Happy daemon is already running');
        process.exit(0);
    }

    // Write PID file to claim daemon ownership
    console.log('[DAEMON] Writing PID file with PID:', process.pid);
    writePidFile();
    console.log('[DAEMON] PID file written successfully');

    logger.info('Happy CLI daemon started successfully');

    // Setup cleanup handlers
    process.on('SIGINT', () => { stopDaemon().catch(console.error); });
    process.on('SIGTERM', () => { stopDaemon().catch(console.error); });
    process.on('exit', () => { stopDaemon().catch(console.error); });

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

export async function isDaemonRunning(): Promise<boolean> {
    try {
        console.log('[isDaemonRunning] Checking if daemon is running...');
        
        // First check PID file
        if (existsSync(configuration.daemonPidFile)) {
            console.log('[isDaemonRunning] PID file exists');
            const pid = parseInt(readFileSync(configuration.daemonPidFile, 'utf-8'));
            console.log('[isDaemonRunning] PID from file:', pid);
            
            // Check if process exists
            try {
                process.kill(pid, 0);
                console.log('[isDaemonRunning] Process exists, checking if it\'s a happy daemon...');
                // Verify it's actually a happy daemon process
                const isHappyDaemon = await isProcessHappyDaemon(pid);
                console.log('[isDaemonRunning] isHappyDaemon:', isHappyDaemon);
                if (isHappyDaemon) {
                    return true;
                } else {
                    // PID file points to wrong process, clean it up
                    console.log('[isDaemonRunning] PID is not a happy daemon, cleaning up');
                    logger.debug(`[DAEMON] PID ${pid} is not a happy daemon, cleaning up`);
                    unlinkSync(configuration.daemonPidFile);
                }
            } catch (error) {
                // Process not running, clean up stale PID file
                console.log('[isDaemonRunning] Process not running, cleaning up stale PID file');
                logger.debug('[DAEMON] Process not running, cleaning up stale PID file');
                unlinkSync(configuration.daemonPidFile);
            }
        } else {
            console.log('[isDaemonRunning] No PID file found');
        }
        
        
        return false;
    } catch (error) {
        console.log('[isDaemonRunning] Error:', error);
        logger.debug('[DAEMON] Error checking daemon status', error);
        return false;
    }
}

function writePidFile() {
    const happyDir = join(homedir(), '.happy');
    if (!existsSync(happyDir)) {
        mkdirSync(happyDir, { recursive: true });
    }
    
    // Atomic write with exclusive flag to prevent race conditions
    try {
        writeFileSync(configuration.daemonPidFile, process.pid.toString(), { flag: 'wx' });
    } catch (error: any) {
        if (error.code === 'EEXIST') {
            logger.debug('[DAEMON] PID file already exists, another daemon may be starting');
            throw new Error('Daemon PID file already exists');
        }
        throw error;
    }
}

export async function stopDaemon() {
    try {
        // Stop daemon from PID file
        if (existsSync(configuration.daemonPidFile)) {
            const pid = parseInt(readFileSync(configuration.daemonPidFile, 'utf-8'));
            logger.debug(`[DAEMON] Stopping daemon with PID ${pid}`);
            try {
                process.kill(pid, 'SIGTERM');
                // Give it time to shutdown gracefully
                await new Promise(resolve => setTimeout(resolve, 1000));
                // Force kill if still running
                try {
                    process.kill(pid, 0);
                    process.kill(pid, 'SIGKILL');
                } catch {
                    // Process already dead
                }
            } catch (error) {
                logger.debug('[DAEMON] Process already dead or inaccessible', error);
            }
            unlinkSync(configuration.daemonPidFile);
        }
    } catch (error) {
        logger.debug('[DAEMON] Error stopping daemon', error);
    }
}

// Helper function to check if a PID belongs to a happy daemon
async function isProcessHappyDaemon(pid: number): Promise<boolean> {
    return new Promise((resolve) => {
        const ps = spawn('ps', ['-p', pid.toString(), '-o', 'command=']);
        let output = '';
        
        ps.stdout.on('data', (data) => {
            output += data.toString();
        });
        
        ps.on('close', () => {
            const isHappyDaemon = output.includes('daemon start') && 
                                 (output.includes('happy') || output.includes('src/index'));
            resolve(isHappyDaemon);
        });
        
        ps.on('error', () => {
            resolve(false);
        });
    });
}