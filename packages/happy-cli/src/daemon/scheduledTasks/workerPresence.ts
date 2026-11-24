/** Relay presence can outlive a stopped worker; never use it alone to skip resume. */
export function scheduledWorkerPresence(pid: number | undefined, probe: (pid: number) => unknown = pid => process.kill(pid, 0)): 'running' | 'stopped' | 'unknown' {
    if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return 'unknown';
    try { probe(pid); return 'running'; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'stopped' : 'unknown'; }
}
