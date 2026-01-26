/**
 * Daemon doctor utilities
 * 
 * Process discovery and cleanup functions for the daemon
 * Helps diagnose and fix issues with hung or orphaned processes
 */

import psList from 'ps-list';
import spawn from 'cross-spawn';

export type HappyProcessInfo = { pid: number; command: string; type: string };

/**
 * Find all Happy CLI processes (including current process)
 */
export function classifyHappyProcess(proc: { pid: number; name?: string; cmd?: string }): HappyProcessInfo | null {
  const cmd = proc.cmd || '';
  const name = proc.name || '';

  // NOTE: Be intentionally strict here. This classification is used for PID reuse safety
  // (reattach + stopSession). A false positive could cause us to adopt/kill a non-Happy process.
  const isHappy =
    (name === 'node' &&
      (cmd.includes('happy-cli') ||
        cmd.includes('dist/index.mjs') ||
        cmd.includes('bin/happy.mjs') ||
        (cmd.includes('tsx') && cmd.includes('src/index.ts') && cmd.includes('happy-cli')))) ||
    cmd.includes('happy.mjs') ||
    cmd.includes('happy-coder') ||
    name === 'happy';

  if (!isHappy) return null;

  // Classify process type
  let type = 'unknown';
  if (proc.pid === process.pid) {
    type = 'current';
  } else if (cmd.includes('--version')) {
    type = cmd.includes('tsx') ? 'dev-daemon-version-check' : 'daemon-version-check';
  } else if (cmd.includes('daemon start-sync') || cmd.includes('daemon start')) {
    type = cmd.includes('tsx') ? 'dev-daemon' : 'daemon';
  } else if (cmd.includes('--started-by daemon')) {
    type = cmd.includes('tsx') ? 'dev-daemon-spawned' : 'daemon-spawned-session';
  } else if (cmd.includes('doctor')) {
    type = cmd.includes('tsx') ? 'dev-doctor' : 'doctor';
  } else if (cmd.includes('--yolo')) {
    type = 'dev-session';
  } else {
    type = cmd.includes('tsx') ? 'dev-related' : 'user-session';
  }

  return { pid: proc.pid, command: cmd || name, type };
}

export async function findAllHappyProcesses(): Promise<HappyProcessInfo[]> {
  try {
    const processes = await psList();
    const allProcesses: HappyProcessInfo[] = [];
    
    for (const proc of processes) {
      const classified = classifyHappyProcess(proc);
      if (!classified) continue;
      allProcesses.push(classified);
    }

    return allProcesses;
  } catch (error) {
    return [];
  }
}

export async function findHappyProcessByPid(pid: number): Promise<HappyProcessInfo | null> {
  const all = await findAllHappyProcesses();
  return all.find((p) => p.pid === pid) ?? null;
}

/**
 * Find all runaway Happy CLI processes that should be killed
 */
export async function findRunawayHappyProcesses(): Promise<Array<{ pid: number, command: string }>> {
  const allProcesses = await findAllHappyProcesses();
  
  // Filter to just runaway processes (excluding current process)
  return allProcesses
    .filter(p => 
      p.pid !== process.pid && (
        p.type === 'daemon' ||
        p.type === 'dev-daemon' ||
        p.type === 'daemon-spawned-session' ||
        p.type === 'dev-daemon-spawned' ||
        p.type === 'daemon-version-check' ||
        p.type === 'dev-daemon-version-check'
      )
    )
    .map(p => ({ pid: p.pid, command: p.command }));
}

/**
 * Kill all runaway Happy CLI processes
 */
export async function killRunawayHappyProcesses(): Promise<{ killed: number, errors: Array<{ pid: number, error: string }> }> {
  const runawayProcesses = await findRunawayHappyProcesses();
  const errors: Array<{ pid: number, error: string }> = [];
  let killed = 0;
  
  for (const { pid, command } of runawayProcesses) {
    try {
      console.log(`Killing runaway process PID ${pid}: ${command}`);
      
      if (process.platform === 'win32') {
        // Windows: use taskkill
        const result = spawn.sync('taskkill', ['/F', '/PID', pid.toString()], { stdio: 'pipe' });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error(`taskkill exited with code ${result.status}`);
      } else {
        // Unix: try SIGTERM first
        process.kill(pid, 'SIGTERM');
        
        // Wait a moment
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Check if still alive
        const processes = await psList();
        const stillAlive = processes.find(p => p.pid === pid);
        if (stillAlive) {
          console.log(`Process PID ${pid} ignored SIGTERM, using SIGKILL`);
          process.kill(pid, 'SIGKILL');
        }
      }
      
      console.log(`Successfully killed runaway process PID ${pid}`);
      killed++;
    } catch (error) {
      const errorMessage = (error as Error).message;
      errors.push({ pid, error: errorMessage });
      console.log(`Failed to kill process PID ${pid}: ${errorMessage}`);
    }
  }

  return { killed, errors };
}