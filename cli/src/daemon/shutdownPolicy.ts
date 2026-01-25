export type DaemonShutdownSource = 'happy-app' | 'happy-cli' | 'os-signal' | 'exception';

export function getDaemonShutdownExitCode(source: DaemonShutdownSource): 0 | 1 {
  return source === 'exception' ? 1 : 0;
}

// A watchdog is useful to avoid hanging forever on shutdown if some cleanup path stalls.
// This should be long enough to not fire during normal shutdown, so the daemon does not
// incorrectly exit with a failure code (which can trigger restart loops + extra log files).
export function getDaemonShutdownWatchdogTimeoutMs(): number {
  return 15_000;
}

