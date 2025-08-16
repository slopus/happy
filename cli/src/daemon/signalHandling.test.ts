/**
 * Test signal handling in Happy CLI processes
 * Validates that individual sessions respect SIGTERM and exit cooperatively
 */

import { spawn, ChildProcess } from 'child_process';
import { join } from 'path';
import { projectPath } from '@/projectPath';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

describe('Signal Handling', () => {
  let testProcess: ChildProcess;
  const happyBinPath = join(projectPath(), 'bin', 'happy.mjs');

  afterAll(() => {
    // Ensure cleanup
    if (testProcess && !testProcess.killed) {
      testProcess.kill('SIGKILL');
    }
  });

  it('should respect SIGTERM and exit gracefully within 5 seconds', async () => {
    // Spawn a Happy CLI process in remote mode (like daemon does)
    testProcess = spawn(happyBinPath, [
      '--happy-starting-mode', 'remote',
      '--started-by', 'daemon'
    ], {
      stdio: 'pipe',
      detached: false
    });

    // Wait for process to start
    await new Promise(resolve => setTimeout(resolve, 2000));

    expect(testProcess.pid).toBeDefined();
    expect(testProcess.killed).toBe(false);

    // Send SIGTERM
    const startTime = Date.now();
    testProcess.kill('SIGTERM');

    // Wait for process to exit
    const exitPromise = new Promise<{ code: number | null, signal: string | null }>((resolve) => {
      testProcess.on('exit', (code, signal) => {
        resolve({ code, signal });
      });
    });

    // Set timeout for exit
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Process did not exit within 5 seconds')), 5000);
    });

    const result = await Promise.race([exitPromise, timeoutPromise]);
    const exitTime = Date.now() - startTime;

    // Validate graceful exit
    expect(exitTime).toBeLessThan(5000);
    expect(result.signal).toBe('SIGTERM');
    expect(testProcess.killed).toBe(true);

    console.log(`Process exited gracefully in ${exitTime}ms with signal ${result.signal}`);
  }, 10000);

  it('should handle SIGINT gracefully', async () => {
    // Spawn another test process
    testProcess = spawn(happyBinPath, [
      '--happy-starting-mode', 'remote', 
      '--started-by', 'daemon'
    ], {
      stdio: 'pipe',
      detached: false
    });

    await new Promise(resolve => setTimeout(resolve, 2000));

    const startTime = Date.now();
    testProcess.kill('SIGINT');

    const exitPromise = new Promise<{ code: number | null, signal: string | null }>((resolve) => {
      testProcess.on('exit', (code, signal) => {
        resolve({ code, signal });
      });
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Process did not exit within 5 seconds')), 5000);
    });

    const result = await Promise.race([exitPromise, timeoutPromise]);
    const exitTime = Date.now() - startTime;

    expect(exitTime).toBeLessThan(5000);
    expect(['SIGINT', 'SIGTERM']).toContain(result.signal);
    
    console.log(`Process exited gracefully in ${exitTime}ms with signal ${result.signal}`);
  }, 10000);

  it('should exit cleanly without hanging processes', async () => {
    const initialProcesses = await getHappyProcessCount();
    
    // Spawn and immediately kill process
    testProcess = spawn(happyBinPath, [
      '--happy-starting-mode', 'remote',
      '--started-by', 'daemon'  
    ], {
      stdio: 'pipe',
      detached: false
    });

    await new Promise(resolve => setTimeout(resolve, 1000));
    
    testProcess.kill('SIGTERM');
    
    await new Promise<void>((resolve) => {
      testProcess.on('exit', () => resolve());
    });

    // Wait a moment for cleanup
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const finalProcesses = await getHappyProcessCount();
    
    // Should not leave hanging processes
    expect(finalProcesses).toBeLessThanOrEqual(initialProcesses);
  }, 10000);
});

async function getHappyProcessCount(): Promise<number> {
  const { execSync } = await import('child_process');
  try {
    const output = execSync('ps aux | grep "happy.mjs.*--started-by daemon" | grep -v grep', { encoding: 'utf8' });
    return output.trim().split('\n').filter(line => line.trim()).length;
  } catch {
    return 0;
  }
}