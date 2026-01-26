import type { ChildProcess } from 'node:child_process';

export async function terminateProcess(child: ChildProcess, opts?: { graceMs?: number }): Promise<void> {
  const graceMs = typeof opts?.graceMs === 'number' ? opts.graceMs : 250;

  const alreadyExited = child.exitCode !== null || child.signalCode !== null;
  if (alreadyExited) return;

  const waitForExit = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });

  try {
    child.kill('SIGTERM');
  } catch {
    // ignore
  }

  await Promise.race([waitForExit, new Promise<void>((resolve) => setTimeout(resolve, graceMs))]);

  const exitedAfterGrace = child.exitCode !== null || child.signalCode !== null;
  if (exitedAfterGrace) return;

  try {
    child.kill('SIGKILL');
  } catch {
    // ignore
  }
}

