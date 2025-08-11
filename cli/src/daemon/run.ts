import { ApiDaemonSession } from './apiDaemonSession'
import { MachineIdentity } from './types'
import { logger } from '@/ui/logger'
import { readSettings, writeSettings, readCredentials } from '@/persistence/persistence'
import { hostname } from 'os'
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync, openSync, writeSync, closeSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { doAuth } from '@/ui/auth'
import crypto from 'crypto'
import { spawn } from 'child_process'
import { configuration } from '@/configuration'
import { startCaffeinate, stopCaffeinate } from '@/utils/caffeinate'

// Store the file descriptor globally to keep the lock
let pidFileFd: number | null = null;

export async function startDaemon(): Promise<void> {
    // IMMEDIATELY check platform
    if (process.platform !== 'darwin') {
        console.error('ERROR: Daemon is only supported on macOS');
        process.exit(1);
    }
    
    logger.daemonDebug('Starting daemon process...');
    logger.daemonDebug(`Server URL: ${configuration.serverUrl}`);
    
    if (await isDaemonRunning()) {
        logger.daemonDebug('Happy daemon is already running');
        process.exit(0);
    }

    // Write PID file to claim daemon ownership
    pidFileFd = writePidFile();
    logger.daemonDebug('PID file written');

    // Start caffeinate to prevent sleep while daemon runs
    const caffeinateStarted = startCaffeinate();
    if (caffeinateStarted) {
        logger.daemonDebug('Sleep prevention enabled for daemon');
    }

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
            logger.daemonDebug('No credentials found, running auth');
            await doAuth();
            credentials = await readCredentials();
            if (!credentials) {
                throw new Error('Failed to authenticate');
            }
        }

        const { token, secret } = credentials;

        // Create daemon session
        const daemon = new ApiDaemonSession(
            token, 
            secret, 
            machineIdentity
        );

        daemon.on('connected', () => {
            logger.daemonDebug('Connected to server event received');
        });

        daemon.on('disconnected', () => {
            logger.daemonDebug('Disconnected from server event received');
        });

        daemon.on('shutdown', () => {
            logger.daemonDebug('Shutdown requested');
            stopDaemon();
            process.exit(0);
        });

        // Connect to server
        daemon.connect();
        logger.daemonDebug('Daemon started successfully');

    } catch (error) {
        logger.daemonDebug('Failed to start daemon', error);
        stopDaemon();
        process.exit(1);
    }

    // Keep process alive
    while (true) {
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

export async function isDaemonRunning(): Promise<boolean> {
    try {
        logger.daemonDebug('[isDaemonRunning] Checking if daemon is running...');
        
        // First check PID file
        if (existsSync(configuration.daemonPidFile)) {
            logger.daemonDebug('[isDaemonRunning] PID file exists');
            const pid = parseInt(readFileSync(configuration.daemonPidFile, 'utf-8'));
            logger.daemonDebug('[isDaemonRunning] PID from file:', pid);
            
            // Check if process exists
            try {
                process.kill(pid, 0);
                logger.daemonDebug('[isDaemonRunning] Process exists, checking if it\'s a happy daemon...');
                // Verify it's actually a happy daemon process
                const isHappyDaemon = await isProcessHappyDaemon(pid);
                logger.daemonDebug('[isDaemonRunning] isHappyDaemon:', isHappyDaemon);
                if (isHappyDaemon) {
                    return true;
                } else {
                    // PID file points to wrong process, clean it up
                    logger.daemonDebug('[isDaemonRunning] PID is not a happy daemon, cleaning up');
                    logger.debug(`PID ${pid} is not a happy daemon, cleaning up`);
                    unlinkSync(configuration.daemonPidFile);
                }
            } catch (error) {
                // Process not running, clean up stale PID file
                logger.daemonDebug('[isDaemonRunning] Process not running, cleaning up stale PID file');
                logger.debug('Process not running, cleaning up stale PID file');
                unlinkSync(configuration.daemonPidFile);
            }
        } else {
            logger.daemonDebug('[isDaemonRunning] No PID file found');
        }
        
        
        return false;
    } catch (error) {
        logger.daemonDebug('[isDaemonRunning] Error:', error);
        logger.debug('Error checking daemon status', error);
        return false;
    }
}

function writePidFile(): number {
    const happyDir = join(homedir(), '.happy');
    if (!existsSync(happyDir)) {
        mkdirSync(happyDir, { recursive: true });
    }
    
    // Try to open with exclusive create flag
    try {
        const fd = openSync(configuration.daemonPidFile, 'wx');
        writeSync(fd, process.pid.toString());
        // Return the file descriptor but DON'T close it - this maintains the lock
        return fd;
    } catch (error: any) {
        if (error.code === 'EEXIST') {
            // File exists, check if we can get a write lock
            try {
                const fd = openSync(configuration.daemonPidFile, 'r+');
                // If we can open for write, the daemon is likely dead
                const existingPid = readFileSync(configuration.daemonPidFile, 'utf-8').trim();
                closeSync(fd);
                
                // Check if that process is still alive
                try {
                    process.kill(parseInt(existingPid), 0);
                    // Process exists
                    logger.daemonDebug('PID file exists and process is running');
                    logger.daemonDebug('Happy daemon is already running');
                    process.exit(0);
                } catch {
                    // Process doesn't exist, clean up stale PID file
                    logger.daemonDebug('PID file exists but process is dead, cleaning up');
                    unlinkSync(configuration.daemonPidFile);
                    // Retry
                    return writePidFile();
                }
            } catch (lockError: any) {
                // Can't get write access, daemon must be running with lock held
                logger.daemonDebug('Cannot acquire write lock on PID file, daemon is running');
                logger.daemonDebug('Happy daemon is already running');
                process.exit(0);
            }
        }
        throw error;
    }
}

export async function stopDaemon() {
    try {
        // Stop caffeinate when stopping daemon
        stopCaffeinate();
        logger.debug('Stopped sleep prevention');
        
        // Close our file descriptor if we have one
        if (pidFileFd !== null) {
            try {
                closeSync(pidFileFd);
            } catch {}
            pidFileFd = null;
        }
        
        // Stop daemon from PID file
        if (existsSync(configuration.daemonPidFile)) {
            const pid = parseInt(readFileSync(configuration.daemonPidFile, 'utf-8'));
            logger.debug(`Stopping daemon with PID ${pid}`);
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
                logger.debug('Process already dead or inaccessible', error);
            }
            unlinkSync(configuration.daemonPidFile);
        }
    } catch (error) {
        logger.debug('Error stopping daemon', error);
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

