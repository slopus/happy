type ChildExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;

type ChildWithExit = {
  kill(signal: NodeJS.Signals): boolean;
  once(event: 'exit', listener: ChildExitListener): unknown;
  off(event: 'exit', listener: ChildExitListener): unknown;
};

type ScheduleSigkillFallbackOptions = {
  pid: number;
  sessionId: string;
  childProcess?: ChildWithExit;
  graceMs: number;
  killProcess?: (pid: number, signal?: NodeJS.Signals | 0) => void;
  log?: (message: string, error?: unknown) => void;
};

export function scheduleSigkillFallback({
  pid,
  sessionId,
  childProcess,
  graceMs,
  killProcess = process.kill,
  log = () => {},
}: ScheduleSigkillFallbackOptions): void {
  if (!childProcess) {
    log(`[DAEMON RUN] SIGKILL fallback skipped for session ${sessionId} (PID ${pid}) - no child process handle`);
    return;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancelFallback = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  timer = setTimeout(() => {
    childProcess.off('exit', cancelFallback);
    try {
      // Probe with signal 0; throws ESRCH if the process is gone.
      killProcess(pid, 0);
      childProcess.kill('SIGKILL');
      log(`[DAEMON RUN] SIGKILL fallback fired for session ${sessionId} (PID ${pid})`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ESRCH') {
        log(`[DAEMON RUN] SIGKILL fallback skipped - PID ${pid} already gone`);
      } else {
        log(`[DAEMON RUN] SIGKILL fallback for PID ${pid} threw:`, err);
      }
    }
  }, graceMs);
  timer.unref?.();

  childProcess.once('exit', cancelFallback);
}
