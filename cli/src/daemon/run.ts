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
import * as http from 'http'
import * as net from 'net'

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
        console.log('Happy daemon is already running');
        process.exit(0);
    }

    // Write PID file to claim daemon ownership
    pidFileFd = writePidFile();
    logger.daemonDebug('PID file written');

    // Setup cleanup handlers
    process.on('SIGINT', () => { stopDaemon().catch(console.error); });
    process.on('SIGTERM', () => { stopDaemon().catch(console.error); });
    process.on('exit', () => { stopDaemon().catch(console.error); });

    try {
        /*
         * HTTP Callback Server
         * 
         * When the daemon receives an RPC call to spawn a new session, it needs to:
         * 1. Spawn a new happy process in a terminal
         * 2. Wait for that process to create its session
         * 3. Return the session ID back via RPC
         * 
         * Since we spawn in a separate terminal process, we can't directly get the session ID.
         * So we create this HTTP server that the spawned process will callback to with its session ID.
         * 
         * Flow:
         * 1. RPC arrives -> generate unique nonce
         * 2. Spawn happy with --happy-daemon-port and --happy-daemon-new-session-nonce
         * 3. Happy process starts, creates session, callbacks to this server
         * 4. Server receives callback with nonce + sessionId
         * 5. RPC response sent back with sessionId
         */
        const sessionCallbacks = new Map<string, (sessionId: string) => void>();
        const httpServer = await createDaemonHttpServer(sessionCallbacks);
        const daemonHttpPort = (httpServer.address() as net.AddressInfo).port;
        logger.daemonDebug(`HTTP callback server listening on port ${daemonHttpPort}`);
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

        // Create daemon session with HTTP port
        const daemon = new ApiDaemonSession(
            token, 
            secret, 
            machineIdentity,
            daemonHttpPort,
            sessionCallbacks
        );

        daemon.on('connected', () => {
            logger.daemonDebug('[DAEMON RUN] Connected to server event received');
        });

        daemon.on('disconnected', () => {
            logger.daemonDebug('[DAEMON RUN] Disconnected from server event received');
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
                    logger.debug(`PID ${pid} is not a happy daemon, cleaning up`);
                    unlinkSync(configuration.daemonPidFile);
                }
            } catch (error) {
                // Process not running, clean up stale PID file
                console.log('[isDaemonRunning] Process not running, cleaning up stale PID file');
                logger.debug('Process not running, cleaning up stale PID file');
                unlinkSync(configuration.daemonPidFile);
            }
        } else {
            console.log('[isDaemonRunning] No PID file found');
        }
        
        
        return false;
    } catch (error) {
        console.log('[isDaemonRunning] Error:', error);
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
                    console.log('Happy daemon is already running');
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
                console.log('Happy daemon is already running');
                process.exit(0);
            }
        }
        throw error;
    }
}

export async function stopDaemon() {
    try {
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

async function createDaemonHttpServer(
    sessionCallbacks: Map<string, (sessionId: string) => void>
): Promise<http.Server> {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            if (req.method === 'POST' && req.url === '/on-new-session') {
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', () => {
                    try {
                        const { nonce, happySessionId, happyProcessId } = JSON.parse(body);
                        logger.daemonDebug(`Received callback: nonce=${nonce}, sessionId=${happySessionId}`);
                        
                        const callback = sessionCallbacks.get(nonce);
                        if (callback) {
                            callback(happySessionId);
                            sessionCallbacks.delete(nonce);
                            res.writeHead(200);
                            res.end(JSON.stringify({ success: true }));
                        } else {
                            logger.daemonDebug(`Invalid nonce: ${nonce}`);
                            res.writeHead(401);
                            res.end(JSON.stringify({ error: 'Invalid nonce' }));
                        }
                    } catch (error) {
                        logger.daemonDebug('Bad request:', error);
                        res.writeHead(400);
                        res.end(JSON.stringify({ error: 'Bad request' }));
                    }
                });
            } else {
                res.writeHead(404);
                res.end();
            }
        });
        
        // Let OS assign random port
        server.listen(0, '127.0.0.1', () => {
            resolve(server);
        });
        
        server.on('error', reject);
    });
}