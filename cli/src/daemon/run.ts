import { DaemonHappyServerSession } from './serverSession';
import { startDaemonControlServer } from './controlServer';
import { MachineIdentity, DaemonMetadata, TrackedSession } from './types';
import { logger } from '@/ui/logger';
import { ensureMachineId, readCredentials } from '@/persistence/persistence';
import { hostname } from 'os';
import { existsSync, unlinkSync, readFileSync } from 'fs';
import { join } from 'path';
import { configuration } from '@/configuration';
import { startCaffeinate, stopCaffeinate } from '@/utils/caffeinate';
import packageJson from '../../package.json';
import { getEnvironmentInfo } from '@/ui/doctor';
import { spawn, ChildProcess } from 'child_process';
import { projectPath } from '@/projectPath';
import { atomicFileWrite } from '@/utils/fileAtomic';
import { Metadata } from '@/api/types';

export async function startDaemon(): Promise<void> {
  logger.debug('[DAEMON RUN] Starting daemon process...');
  logger.debugLargeJson('[DAEMON RUN] Environment', getEnvironmentInfo());
  
  // Check if already running
  const runningDaemon = await getDaemonMetadata();
  if (runningDaemon) {
    if (await isDaemonProcessRunning(runningDaemon.pid)) {
      logger.debug('[DAEMON RUN] Daemon already running');
      process.exit(0);
    } else {
      logger.debug('[DAEMON RUN] Stale metadata found, cleaning up');
      await cleanupDaemonMetadata();
    }
  }

  // Start caffeinate
  const caffeinateStarted = startCaffeinate();
  if (caffeinateStarted) {
    logger.debug('[DAEMON RUN] Sleep prevention enabled');
  }

  try {
    // Setup state - key by PID
    const pidToTrackedSession = new Map<number, TrackedSession>();
    
    // Helper functions
    const getCurrentChildren = () => Array.from(pidToTrackedSession.values());
    
    // Handle webhook from happy session reporting itself
    const onHappySessionWebhook = (sessionId: string, sessionMetadata: Metadata) => {
      const pid = sessionMetadata.hostPid;
      if (!pid) {
        logger.debug(`[DAEMON RUN] Session webhook missing hostPid for session ${sessionId}`);
        return;
      }
      
      logger.debug(`[DAEMON RUN] Session webhook: ${sessionId}, PID: ${pid}, started by: ${sessionMetadata.startedBy || 'unknown'}`);
      
      // Check if we already have this PID (daemon-spawned)
      const existingSession = pidToTrackedSession.get(pid);
      
      if (existingSession && existingSession.startedBy === 'daemon') {
        // Update daemon-spawned session with reported data
        existingSession.happySessionId = sessionId;
        existingSession.happySessionMetadataFromLocalWebhook = sessionMetadata;
        logger.debug(`[DAEMON RUN] Updated daemon-spawned session ${sessionId} with metadata`);
      } else if (!existingSession) {
        // New session started externally
        const trackedSession: TrackedSession = {
          startedBy: 'happy directly - likely by user from terminal',
          happySessionId: sessionId,
          happySessionMetadataFromLocalWebhook: sessionMetadata,
          pid
        };
        pidToTrackedSession.set(pid, trackedSession);
        logger.debug(`[DAEMON RUN] Registered externally-started session ${sessionId}`);
      }
    };
    
    // Spawn a new session (with optional sessionId for resume)
    const spawnSession = (directory: string, sessionId?: string): TrackedSession | null => {
      try {
        const happyBinPath = join(projectPath(), 'bin', 'happy.mjs');
        const args = [
          '--happy-starting-mode', 'remote',
          '--started-by', 'daemon'
        ];
        
        // Add resume flag if sessionId provided
        if (sessionId) {
          args.push('--resume', sessionId);
        }
        
        const fullCommand = `${happyBinPath} ${args.join(' ')}`;
        logger.debug(`[DAEMON RUN] Spawning: ${fullCommand} in ${directory}`);
        
        const happyProcess = spawn(happyBinPath, args, {
          cwd: directory,
          detached: false,  // Dies with daemon
          stdio: 'ignore'
        });
        
        if (!happyProcess.pid) {
          logger.debug('[DAEMON RUN] Failed to spawn process - no PID returned');
          return null;
        }
        
        logger.debug(`[DAEMON RUN] Spawned process with PID ${happyProcess.pid}`);
        
        const trackedSession: TrackedSession = {
          startedBy: 'daemon',
          pid: happyProcess.pid,
          childProcess: happyProcess
        };
        
        pidToTrackedSession.set(happyProcess.pid, trackedSession);
        
        happyProcess.on('exit', (code, signal) => {
          logger.debug(`[DAEMON RUN] Child PID ${happyProcess.pid} exited with code ${code}, signal ${signal}`);
          if (happyProcess.pid) {
            onChildExited(happyProcess.pid);
          }
        });
        
        happyProcess.on('error', (error) => {
          logger.debug(`[DAEMON RUN] Child process error:`, error);
          if (happyProcess.pid) {
            onChildExited(happyProcess.pid);
          }
        });
        
        return trackedSession;
      } catch (error) {
        logger.debug('[DAEMON RUN] Failed to spawn session:', error);
        return null;
      }
    };
    
    // Stop a session by sessionId or PID fallback
    const stopSession = (sessionId: string): boolean => {
      logger.debug(`[DAEMON RUN] Attempting to stop session ${sessionId}`);
      
      // Try to find by sessionId first
      for (const [pid, session] of pidToTrackedSession.entries()) {
        if (session.happySessionId === sessionId || 
            (sessionId.startsWith('PID-') && pid === parseInt(sessionId.replace('PID-', '')))) {
          
          if (session.startedBy === 'daemon' && session.childProcess) {
            try {
              session.childProcess.kill('SIGTERM');
              logger.debug(`[DAEMON RUN] Sent SIGTERM to daemon-spawned session ${sessionId}`);
            } catch (error) {
              logger.debug(`[DAEMON RUN] Failed to kill session ${sessionId}:`, error);
            }
          } else {
            // For externally started sessions, try to kill by PID
            try {
              process.kill(pid, 'SIGTERM');
              logger.debug(`[DAEMON RUN] Sent SIGTERM to external session PID ${pid}`);
            } catch (error) {
              logger.debug(`[DAEMON RUN] Failed to kill external session PID ${pid}:`, error);
            }
          }
          
          pidToTrackedSession.delete(pid);
          logger.debug(`[DAEMON RUN] Removed session ${sessionId} from tracking`);
          return true;
        }
      }
      
      logger.debug(`[DAEMON RUN] Session ${sessionId} not found`);
      return false;
    };
    
    // Handle child process exit
    const onChildExited = (pid: number) => {
      logger.debug(`[DAEMON RUN] Removing exited process PID ${pid} from tracking`);
      pidToTrackedSession.delete(pid);
    };

    // Setup shutdown promise
    let requestShutdown: () => void;
    const shutdownPromise = new Promise<void>((resolve) => {
      requestShutdown = resolve;
    });

    // Start control server
    const { port: controlPort, stop: stopControlServer } = await startDaemonControlServer({
      getChildren: getCurrentChildren,
      stopSession,
      spawnSession,
      requestShutdown: () => requestShutdown(),
      onHappySessionWebhook
    });

    // Write daemon metadata atomically
    const metadata: DaemonMetadata = {
      pid: process.pid,
      httpPort: controlPort,
      startTime: new Date().toISOString(),
      version: packageJson.version
    };
    await atomicFileWrite(configuration.daemonMetadataFile, JSON.stringify(metadata, null, 2));
    logger.debug('[DAEMON RUN] Daemon metadata written');

    // Get credentials and machine identity
    const settings = await ensureMachineId();
    const machineIdentity: MachineIdentity = {
      machineId: settings.machineId!,
      machineHost: settings.machineHost || hostname(),
      platform: process.platform,
      happyCliVersion: packageJson.version,
      happyHomeDirectory: process.cwd()
    };

    const credentials = await readCredentials();
    if (!credentials) {
      throw new Error('No credentials found');
    }

    // Start server session
    const serverSession = new DaemonHappyServerSession(
      credentials,
      machineIdentity,
      spawnSession,
      stopSession
    );

    serverSession.connect();

    // Setup signal handlers
    const cleanup = async () => {
      logger.debug('[DAEMON RUN] Starting cleanup...');
      
      // Kill all daemon-spawned children
      let killedCount = 0;
      for (const session of pidToTrackedSession.values()) {
        if (session.startedBy === 'daemon' && session.childProcess) {
          try {
            session.childProcess.kill('SIGTERM');
            killedCount++;
          } catch {}
        }
      }
      logger.debug(`[DAEMON RUN] Killed ${killedCount} daemon-spawned children`);
      
      // Shutdown server session
      serverSession.shutdown();
      logger.debug('[DAEMON RUN] Server session shutdown');
      
      // Stop control server
      await stopControlServer();
      logger.debug('[DAEMON RUN] Control server stopped');
      
      // Clean up metadata
      await cleanupDaemonMetadata();
      logger.debug('[DAEMON RUN] Metadata cleaned up');
      
      // Stop caffeinate
      stopCaffeinate();
      logger.debug('[DAEMON RUN] Caffeinate stopped');
      
      process.exit(0);
    };

    process.on('SIGINT', () => {
      logger.debug('[DAEMON RUN] Received SIGINT');
      cleanup();
    });
    
    process.on('SIGTERM', () => {
      logger.debug('[DAEMON RUN] Received SIGTERM');
      cleanup();
    });

    logger.debug('[DAEMON RUN] Daemon started successfully');

    // Wait for shutdown request
    await shutdownPromise;
    logger.debug('[DAEMON RUN] Shutdown requested');
    
    // Cleanup and exit
    await cleanup();

  } catch (error) {
    logger.debug('[DAEMON RUN] Failed to start daemon', error);
    await cleanupDaemonMetadata();
    stopCaffeinate();
    process.exit(1);
  }
}

export async function isDaemonRunning(): Promise<boolean> {
  try {
    const metadata = await getDaemonMetadata();
    if (!metadata) {
      return false;
    }
    
    const isRunning = await isDaemonProcessRunning(metadata.pid);
    if (!isRunning) {
      logger.debug('[DAEMON RUN] Daemon PID not running, cleaning up metadata');
      await cleanupDaemonMetadata();
      return false;
    }
    
    return true;
  } catch (error) {
    logger.debug('[DAEMON RUN] Error checking daemon status', error);
    return false;
  }
}

export async function getDaemonMetadata(): Promise<DaemonMetadata | null> {
  try {
    if (!existsSync(configuration.daemonMetadataFile)) {
      return null;
    }
    const content = readFileSync(configuration.daemonMetadataFile, 'utf-8');
    return JSON.parse(content) as DaemonMetadata;
  } catch (error) {
    logger.debug('[DAEMON RUN] Error reading daemon metadata', error);
    return null;
  }
}

async function isDaemonProcessRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cleanupDaemonMetadata(): Promise<void> {
  try {
    if (existsSync(configuration.daemonMetadataFile)) {
      unlinkSync(configuration.daemonMetadataFile);
      logger.debug('[DAEMON RUN] Daemon metadata file removed');
    }
  } catch (error) {
    logger.debug('[DAEMON RUN] Error cleaning up daemon metadata', error);
  }
}

export async function stopDaemon() {
  try {
    stopCaffeinate();
    logger.debug('Stopped sleep prevention');

    const metadata = await getDaemonMetadata();
    if (!metadata) {
      logger.debug('No daemon metadata found');
      return;
    }

    logger.debug(`Stopping daemon with PID ${metadata.pid}`);
    
    // Try HTTP graceful stop
    try {
      const { stopDaemonHttp } = await import('./controlClient');
      await stopDaemonHttp();
      
      // Wait for daemon to die
      await waitForProcessDeath(metadata.pid, 5000);
      logger.debug('Daemon stopped gracefully via HTTP');
      return;
    } catch (error) {
      logger.debug('HTTP stop failed, will force kill', error);
    }
    
    // Force kill
    try {
      process.kill(metadata.pid, 'SIGKILL');
      logger.debug('Force killed daemon');
    } catch (error) {
      logger.debug('Daemon already dead');
    }
  } catch (error) {
    logger.debug('Error stopping daemon', error);
  }
}

async function waitForProcessDeath(pid: number, timeout: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      process.kill(pid, 0);
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch {
      return; // Process is dead
    }
  }
  throw new Error('Process did not die within timeout');
}

