/**
 * Daemon doctor utilities
 * 
 * Process discovery and cleanup functions for the daemon
 * Helps diagnose and fix issues with hung or orphaned processes
 */

import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { promisify } from 'node:util';
import psList from 'ps-list';
import spawn from 'cross-spawn';

const execFileAsync = promisify(execFile);
const windowsHappyEntrypoint = /(?:^|[/\s"])(?:happy(?:-coder|-cli)?\/(?:dist\/index\.mjs|src\/index\.ts)|bin\/happy\.mjs)(?=$|[\s"])/i;

async function listWindowsProcesses() {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    "$processes = Get-CimInstance -ClassName Win32_Process | Where-Object { $_.Name -in 'node.exe', 'bun.exe' -and $_.CommandLine } | Select-Object ProcessId, Name, CommandLine",
    'ConvertTo-Json -InputObject @($processes) -Compress',
  ].join('; ');
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    { windowsHide: true, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 },
  );
  const processes: Array<{ ProcessId: number, Name: string, CommandLine: string | null }> = JSON.parse(stdout);
  return processes.map(({ ProcessId, Name, CommandLine }) => ({
    pid: ProcessId, name: Name, cmd: CommandLine ?? '',
  }));
}

/**
 * Find all Happy CLI processes (including current process)
 */
export async function findAllHappyProcesses(): Promise<Array<{ pid: number, command: string, type: string }>> {
  const windows = platform() === 'win32';
  const processes = windows ? await listWindowsProcesses() : await psList();
  return classifyHappyProcesses(processes, windows);
}

function classifyHappyProcesses(
  processes: Array<{ pid: number, name?: string, cmd?: string }>,
  windows = false,
): Array<{ pid: number, command: string, type: string }> {
  const allProcesses: Array<{ pid: number, command: string, type: string }> = [];

  for (const proc of processes) {
    const cmd = proc.cmd || '';
    const name = proc.name || '';

    const isHappy = windows
      ? windowsHappyEntrypoint.test(cmd.replaceAll('\\', '/'))
      : name.includes('happy') ||
        name === 'node' && (cmd.includes('happy-cli') || cmd.includes('dist/index.mjs')) ||
        cmd.includes('happy.mjs') ||
        cmd.includes('happy-coder') || // legacy npm package name
        cmd.includes('/happy/') ||
        (cmd.includes('tsx') && cmd.includes('src/index.ts') && cmd.includes('happy-cli'));
    if (!isHappy) continue;

    let type: string;
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

    allProcesses.push({ pid: proc.pid, command: cmd || name, type });
  }

  return allProcesses;
}

/**
 * Find all runaway Happy CLI processes that should be killed
 */
export async function findRunawayHappyProcesses(): Promise<Array<{ pid: number, command: string }>> {
  // Keep the existing process inventory for cleanup. The Windows CIM inventory
  // is only used by the read-only report.
  const allProcesses = classifyHappyProcesses(await psList().catch(() => []));
  
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
