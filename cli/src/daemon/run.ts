import { ApiDaemonSession } from './apiDaemonSession'
import { MachineIdentity } from './types'
import { logger } from '@/ui/logger'
import { ensureMachineId, readCredentials } from '@/persistence/persistence'
import { hostname } from 'os'
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { doAuth } from '@/ui/auth'
import { spawn } from 'child_process'
import { configuration } from '@/configuration'
import { startCaffeinate, stopCaffeinate } from '@/utils/caffeinate'
import packageJson from '../../package.json'
import { getEnvironmentInfo } from '@/ui/doctor'

interface DaemonMetadata {
    pid: number;
    startTime: string;
    version: string;
    childPids?: number[];
}

/**
 * Will be called from the same index.ts file as the regular CLI.
 * Will be running in a separate process.
 * 
 * Usually
 * - User runs `happy`
 * - We offer them to start the daemon
 * - If yes, we run the CLI itself with `daemon start` parameters & detach
 * - Finally in the new process we run this `startDaemon` function
 */
export async function startDaemon(): Promise<void> {
    // IMMEDIATELY check platform
    if (process.platform !== 'darwin') {
        console.error('ERROR: Daemon is only supported on macOS');
        process.exit(1);
    }
    
    logger.debug('[DAEMON RUN] Starting daemon process...');
    logger.debugLargeJson('[DAEMON RUN] Daemon starting with environment', getEnvironmentInfo());
    logger.debug(`[DAEMON RUN] Server URL: ${configuration.serverUrl}`);
    
    const runningDaemon = await getDaemonMetadata();
    if (runningDaemon) {
        if (runningDaemon.version !== packageJson.version) {
            logger.debug(`[DAEMON RUN] Daemon version mismatch (running: ${runningDaemon.version}, current: ${packageJson.version}), restarting...`);
            await stopDaemon();
            // Small delay to ensure cleanup
            await new Promise(resolve => setTimeout(resolve, 500));
        } else if (await isDaemonProcessRunning(runningDaemon.pid)) {
            logger.debug('[DAEMON RUN] Happy daemon is already running with correct version');
            process.exit(0);
        } else {
            logger.debug('[DAEMON RUN] Stale daemon metadata found, cleaning up');
            await cleanupDaemonMetadata();
        }
    }

    // First, clean up any orphaned child processes from previous run
    const oldMetadata = await getDaemonMetadata();
    if (oldMetadata && oldMetadata.childPids && oldMetadata.childPids.length > 0) {
        logger.debug(`[DAEMON RUN] Found ${oldMetadata.childPids.length} potential orphaned child processes from previous run`);
        for (const childPid of oldMetadata.childPids) {
            try {
                // Check if process still exists
                process.kill(childPid, 0);
                
                // Process exists - verify it's a happy process before killing
                const isHappy = await isProcessHappyChild(childPid);
                if (isHappy) {
                    logger.debug(`[DAEMON RUN] Killing orphaned happy process ${childPid}`);
                    process.kill(childPid, 'SIGTERM');
                    await new Promise(resolve => setTimeout(resolve, 500));
                    try {
                        process.kill(childPid, 0);
                        process.kill(childPid, 'SIGKILL');
                    } catch {
                        // Already dead
                    }
                }
            } catch {
                // Process doesn't exist, that's fine
                logger.debug(`[DAEMON RUN] Process ${childPid} doesn't exist (already dead)`);
            }
        }
    }
    
    // Write daemon metadata
    writeDaemonMetadata();
    logger.debug('[DAEMON RUN] Daemon metadata written');

    // Start caffeinate to prevent sleep while daemon runs
    const caffeinateStarted = startCaffeinate();
    if (caffeinateStarted) {
        logger.debug('[DAEMON RUN] Sleep prevention enabled for daemon');
    }

    try {
        // Ensure machine ID exists
        const settings = await ensureMachineId();
        logger.debug(`[DAEMON RUN] Using machineId: ${settings.machineId}`);

        const machineIdentity: MachineIdentity = {
            machineId: settings.machineId!,
            machineHost: settings.machineHost || hostname(),
            platform: process.platform,
            happyCliVersion: packageJson.version,
            happyHomeDirectory: process.cwd()
        };

        // Get auth token and secret
        let credentials = await readCredentials();
        if (!credentials) {
            logger.debug('[DAEMON RUN] No credentials found, running auth');
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
            logger.debug('[DAEMON RUN] Connected to server event received');
        });

        daemon.on('disconnected', () => {
            logger.debug('[DAEMON RUN] Disconnected from server event received');
        });

        daemon.on('shutdown', () => {
            logger.debug('[DAEMON RUN] Shutdown requested');
            daemon?.shutdown();
            cleanupDaemonMetadata();
            process.exit(0);
        });

        // Connect to server
        daemon.connect();
        logger.debug('[DAEMON RUN] Daemon started successfully');


        // Setup cleanup handlers
        process.on('SIGINT', async () => {
            logger.debug('[DAEMON RUN] Received SIGINT, shutting down...');
            if (daemon) {
                daemon.shutdown(); // This kills all spawned processes
            }
            await cleanupDaemonMetadata(); // Clean up our own metadata file
            process.exit(0);
        });
        
        process.on('SIGTERM', async () => {
            logger.debug('[DAEMON RUN] Received SIGTERM, shutting down...');
            if (daemon) {
                daemon.shutdown(); // This kills all spawned processes
            }
            await cleanupDaemonMetadata(); // Clean up our own metadata file
            process.exit(0);
        });

    } catch (error) {
        logger.debug('[DAEMON RUN] Failed to start daemon', error);
        await cleanupDaemonMetadata();
        stopCaffeinate();
        process.exit(1);
    }

    // Keep process alive
    while (true) {
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

export async function isDaemonRunning(): Promise<boolean> {
    try {
        logger.debug('[DAEMON RUN] [isDaemonRunning] Checking if daemon is running...');
        
        const metadata = await getDaemonMetadata();
        if (!metadata) {
            logger.debug('[DAEMON RUN] [isDaemonRunning] No daemon metadata found');
            return false;
        }
        
        logger.debug('[DAEMON RUN] [isDaemonRunning] Daemon metadata exists');
        logger.debug('[DAEMON RUN] [isDaemonRunning] PID from metadata:', metadata.pid);
        
        // Check if process exists and is a happy daemon
        const isRunning = await isDaemonProcessRunning(metadata.pid);
        if (!isRunning) {
            logger.debug('[DAEMON RUN] [isDaemonRunning] Process not running, cleaning up stale metadata');
            await cleanupDaemonMetadata();
            return false;
        }
        
        return true;
    } catch (error) {
        logger.debug('[DAEMON RUN] [isDaemonRunning] Error:', error);
        logger.debug('Error checking daemon status', error);
        return false;
    }
}

async function isDaemonProcessRunning(pid: number): Promise<boolean> {
    try {
        process.kill(pid, 0);
        logger.debug('[DAEMON RUN] Process exists, checking if it\'s a happy daemon...');
        // Verify it's actually a happy daemon process
        const isHappyDaemon = await isProcessHappyDaemon(pid);
        logger.debug('[DAEMON RUN] isHappyDaemon:', isHappyDaemon);
        return isHappyDaemon;
    } catch (error) {
        return false;
    }
}

function writeDaemonMetadata(childPids?: number[]): void {
    const happyDir = join(homedir(), '.happy');
    if (!existsSync(happyDir)) {
        mkdirSync(happyDir, { recursive: true });
    }
    
    const metadata: DaemonMetadata = {
        pid: process.pid,
        startTime: new Date().toISOString(),
        version: packageJson.version,
        ...(childPids && { childPids })
    };
    
    writeFileSync(configuration.daemonMetadataFile, JSON.stringify(metadata, null, 2));
}

export async function getDaemonMetadata(): Promise<DaemonMetadata | null> {
    try {
        if (!existsSync(configuration.daemonMetadataFile)) {
            return null;
        }
        const content = readFileSync(configuration.daemonMetadataFile, 'utf-8');
        return JSON.parse(content) as DaemonMetadata;
    } catch (error) {
        logger.debug('Error reading daemon metadata', error);
        return null;
    }
}

async function cleanupDaemonMetadata(): Promise<void> {
    try {
        if (existsSync(configuration.daemonMetadataFile)) {
            unlinkSync(configuration.daemonMetadataFile);
        }
    } catch (error) {
        logger.debug('Error cleaning up daemon metadata', error);
    }
}

export async function stopDaemon() {
    try {
        // Stop caffeinate when stopping daemon
        stopCaffeinate();
        logger.debug('Stopped sleep prevention');

        // Get daemon metadata to find PID
        const metadata = await getDaemonMetadata();
        if (metadata) {
            logger.debug(`Stopping daemon with PID ${metadata.pid}`);
            
            try {
                // Send SIGTERM to daemon and let it clean up its own children
                process.kill(metadata.pid, 'SIGTERM');
                
                // Give it time to shutdown gracefully (including killing its children)
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                // Check if daemon process is still running
                try {
                    process.kill(metadata.pid, 0);
                    // Still running, force kill
                    logger.debug('Daemon still running, force killing...');
                    process.kill(metadata.pid, 'SIGKILL');
                } catch {
                    // Process already dead - good
                    logger.debug('Daemon exited cleanly');
                }
            } catch (error) {
                logger.debug('Daemon process already dead or inaccessible', error);
            }
            
            // Wait a bit more for cleanup
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // NOW check if there are any orphaned child processes
            // This only happens if daemon crashed or didn't clean up properly
            if (metadata.childPids && metadata.childPids.length > 0) {
                logger.debug(`Checking for ${metadata.childPids.length} potential orphaned child processes...`);
                for (const childPid of metadata.childPids) {
                    try {
                        // Check if process still exists
                        process.kill(childPid, 0);
                        
                        // Process exists - verify it's a happy process before killing
                        const isHappy = await isProcessHappyChild(childPid);
                        if (isHappy) {
                            logger.debug(`Killing orphaned happy process ${childPid}`);
                            process.kill(childPid, 'SIGTERM');
                            await new Promise(resolve => setTimeout(resolve, 500));
                            try {
                                process.kill(childPid, 0);
                                process.kill(childPid, 'SIGKILL');
                            } catch {
                                // Already dead
                            }
                        }
                    } catch {
                        // Process doesn't exist, that's fine
                    }
                }
            }
            
            // Only clean up metadata file after everything is done
            await cleanupDaemonMetadata();
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

// Helper function to check if a PID belongs to a happy child process
async function isProcessHappyChild(pid: number): Promise<boolean> {
    return new Promise((resolve) => {
        const ps = spawn('ps', ['-p', pid.toString(), '-o', 'command=']);
        let output = '';
        
        ps.stdout.on('data', (data) => {
            output += data.toString();
        });
        
        ps.on('close', () => {
            const isHappyChild = output.includes('--daemon-spawn') && 
                                (output.includes('happy') || output.includes('src/index'));
            resolve(isHappyChild);
        });
        
        ps.on('error', () => {
            resolve(false);
        });
    });
}

