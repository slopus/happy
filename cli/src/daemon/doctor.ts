/**
 * Daemon doctor utilities
 * 
 * Process discovery and cleanup functions for the daemon
 * Helps diagnose and fix issues with hung or orphaned processes
 */

import { execSync } from 'node:child_process';

/**
 * Find all Happy CLI processes (including current process)
 */
export function findAllHappyProcesses(): Array<{ pid: number, command: string, type: string }> {
  try {
    const allProcesses: Array<{ pid: number, command: string, type: string }> = [];
    
    // Search for production happy processes (happy.mjs, happy-coder, or compiled dist/index.mjs)
    try {
      const happyOutput = execSync('ps aux | grep -E "(happy\\.mjs|happy-coder|happy-cli.*dist/index\\.mjs)" | grep -v grep', { encoding: 'utf8' });
      const happyLines = happyOutput.trim().split('\n').filter(line => line.trim());

      for (const line of happyLines) {
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
    } catch {
      // No production processes found
    }

    // Search for development processes (tsx with src/index.ts)
    try {
      const devOutput = execSync('ps aux | grep -E "tsx.*src/index\\.ts" | grep -v grep', { encoding: 'utf8' });
      const devLines = devOutput.trim().split('\n').filter(line => line.trim());

      for (const line of devLines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 11) continue;

        const pid = parseInt(parts[1]);
        const command = parts.slice(10).join(' ');

        // Check if it's happy-cli related
        if (!command.includes('happy-cli/node_modules/tsx') && !command.includes('/bin/tsx src/index.ts')) {
          continue;
        }

        // Classify process type for dev processes
        let type = 'unknown';
        if (pid === process.pid) {
          type = 'current';
        } else if (command.includes('daemon start-sync') || command.includes('daemon start')) {
          type = 'dev-daemon';
        } else if (command.includes('--started-by daemon')) {
          type = 'dev-daemon-spawned';
        } else if (command.includes('doctor')) {
          type = 'dev-doctor';
        } else if (command.includes('--yolo')) {
          type = 'dev-session';
        } else {
          type = 'dev-related';
        }

        allProcesses.push({ pid, command, type });
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
    const processes: Array<{ pid: number, command: string }> = [];
    
    // Find production Happy CLI processes
    try {
      const output = execSync('ps aux | grep -E "(happy\\.mjs|happy-coder|happy-cli.*dist/index\\.mjs)" | grep -v grep', { encoding: 'utf8' });
      const lines = output.trim().split('\n').filter(line => line.trim());

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
    } catch {
      // No production processes found
    }

    // Find development Happy CLI processes
    try {
      const devOutput = execSync('ps aux | grep -E "tsx.*src/index\\.ts" | grep -v grep', { encoding: 'utf8' });
      const devLines = devOutput.trim().split('\n').filter(line => line.trim());

      for (const line of devLines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 11) continue;

        const pid = parseInt(parts[1]);
        const command = parts.slice(10).join(' ');

        // Skip current process
        if (pid === process.pid) continue;

        // Check if it's happy-cli related
        if (!command.includes('happy-cli/node_modules/tsx') && !command.includes('/bin/tsx src/index.ts')) {
          continue;
        }

        // Include daemon and daemon-spawned sessions
        if (command.includes('--started-by daemon') ||
          command.includes('daemon start-sync') ||
          command.includes('daemon start')) {
          processes.push({ pid, command });
        }
      }
    } catch {
      // No dev processes found
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