/**
 * Daemon utility functions
 * 
 * Provides status checking and control functions for the daemon
 * Extracted to avoid circular dependencies with ui/doctor.ts
 */

import { DaemonState } from './types';
import { logger } from '@/ui/logger';
import { existsSync, unlinkSync, readFileSync } from 'fs';
import { configuration } from '@/configuration';
import { stopCaffeinate } from '@/utils/caffeinate';
import { execSync } from 'node:child_process';

export async function isDaemonRunning(): Promise<boolean> {
  try {
    const state = await getDaemonState();
    if (!state) {
      return false;
    }
    
    const isRunning = await isDaemonProcessRunning(state.pid);
    if (!isRunning) {
      logger.debug('[DAEMON RUN] Daemon PID not running, cleaning up state');
      await cleanupDaemonState();
      return false;
    }
    
    return true;
  } catch (error) {
    logger.debug('[DAEMON RUN] Error checking daemon status', error);
    return false;
  }
}

export async function getDaemonState(): Promise<DaemonState | null> {
  try {
    if (!existsSync(configuration.daemonStateFile)) {
      return null;
    }
    const content = readFileSync(configuration.daemonStateFile, 'utf-8');
    return JSON.parse(content) as DaemonState;
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

export async function cleanupDaemonState(): Promise<void> {
  try {
    if (existsSync(configuration.daemonStateFile)) {
      unlinkSync(configuration.daemonStateFile);
      logger.debug('[DAEMON RUN] Daemon state file removed');
    }
  } catch (error) {
    logger.debug('[DAEMON RUN] Error cleaning up daemon metadata', error);
  }
}

/**
 * Find all Happy CLI processes (including current process)
 */
export function findAllHappyProcesses(): Array<{ pid: number, command: string, type: string }> {
  try {
    // Search specifically for happy.mjs processes
    const output = execSync('ps aux | grep "happy.mjs" | grep -v grep', { encoding: 'utf8' });
    const lines = output.trim().split('\n').filter(line => line.trim());
    
    const allProcesses: Array<{ pid: number, command: string, type: string }> = [];
    
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 11) continue;
      
      const pid = parseInt(parts[1]);
      const command = parts.slice(10).join(' ');
      
      // Classify process type
      let type = 'unknown';
      if (pid === process.pid) {
        type = 'current';
      } else if (command.includes('daemon start-sync') || command.includes('daemon start')) {
        type = 'daemon';
      } else if (command.includes('--started-by daemon')) {
        type = 'daemon-spawned-session';
      } else if (command.includes('doctor')) {
        type = 'doctor';
      } else {
        type = 'user-session';
      }
      
      allProcesses.push({ pid, command, type });
    }
    
    // Also check for dev processes in happy-cli directory
    try {
      const devOutput = execSync('ps aux | grep -E "(tsx.*src/index.ts|yarn.*tsx)" | grep -v grep', { encoding: 'utf8' });
      const devLines = devOutput.trim().split('\n').filter(line => line.trim());
      
      for (const line of devLines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 11) continue;
        
        const pid = parseInt(parts[1]);
        const command = parts.slice(10).join(' ');
        
        // Check if it's in happy-cli directory
        let workingDir = '';
        try {
          const pwdOutput = execSync(`pwdx ${pid} 2>/dev/null`, { encoding: 'utf8' });
          workingDir = pwdOutput.replace(`${pid}:`, '').trim();
        } catch {}
        
        if (workingDir.includes('happy-cli')) {
          allProcesses.push({ pid, command, type: 'dev-session' });
        }
      }
    } catch {
      // No dev processes found
    }
    
    return allProcesses;
  } catch (error) {
    return [];
  }
}

/**
 * Find all runaway Happy CLI processes that should be killed
 */
export function findRunawayHappyProcesses(): Array<{ pid: number, command: string }> {
  
  try {
    // Find all Happy CLI processes except current daemon process
    const output = execSync('ps aux | grep "happy.mjs" | grep -v grep', { encoding: 'utf8' });
    const lines = output.trim().split('\n').filter(line => line.trim());
    
    const processes: Array<{ pid: number, command: string }> = [];
    
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 11) continue;
      
      const pid = parseInt(parts[1]);
      const command = parts.slice(10).join(' ');
      
      // Skip current process
      if (pid === process.pid) continue;
      
      // Include daemon-spawned sessions and hung daemons
      if (command.includes('--started-by daemon') || 
          command.includes('daemon start-sync') ||
          command.includes('daemon start')) {
        processes.push({ pid, command });
      }
    }
    
    return processes;
  } catch (error) {
    return [];
  }
}

/**
 * Kill all runaway Happy CLI processes
 */
export async function killRunawayHappyProcesses(): Promise<{ killed: number, errors: Array<{ pid: number, error: string }> }> {
  const runawayProcesses = findRunawayHappyProcesses();
  const errors: Array<{ pid: number, error: string }> = [];
  let killed = 0;
  
  for (const { pid, command } of runawayProcesses) {
    try {
      // Try SIGTERM first
      process.kill(pid, 'SIGTERM');
      
      // Wait a moment to see if it responds
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Check if it's still alive
      try {
        process.kill(pid, 0); // Signal 0 just checks if process exists
        // Still alive, use SIGKILL
        console.log(`Process PID ${pid} ignored SIGTERM, using SIGKILL`);
        process.kill(pid, 'SIGKILL');
      } catch {
        // Process is dead from SIGTERM
      }
      
      killed++;
      console.log(`Killed runaway process PID ${pid}: ${command}`);
    } catch (error) {
      errors.push({ pid, error: (error as Error).message });
    }
  }
  
  return { killed, errors };
}


export async function stopDaemon() {
  try {
    stopCaffeinate();
    logger.debug('Stopped sleep prevention');

    const state = await getDaemonState();
    if (!state) {
      logger.debug('No daemon state found');
      return;
    }

    logger.debug(`Stopping daemon with PID ${state.pid}`);
    
    // Try HTTP graceful stop
    try {
      const { stopDaemonHttp } = await import('./controlClient');
      await stopDaemonHttp();
      
      // Wait for daemon to die
      await waitForProcessDeath(state.pid, 5000);
      logger.debug('Daemon stopped gracefully via HTTP');
      return;
    } catch (error) {
      logger.debug('HTTP stop failed, will force kill', error);
    }
    
    // Force kill
    try {
      process.kill(state.pid, 'SIGKILL');
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