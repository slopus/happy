/**
 * Writer lock check (D9). The container entrypoint takes an exclusive kernel
 * flock on `runtime.flock` (a file that is never replaced) and execs node
 * without forking, so the lock lives exactly as long as this process. Before
 * opening the TaskStore or CDP the Runtime confirms, from /proc/locks, that it
 * really holds that lock; the heartbeat lease and fencing token stay as a
 * second line of defence.
 */
import { readFile, stat } from 'node:fs/promises'

/** True when /proc/locks shows an active exclusive FLOCK by `pid` on inode `inode`. */
export function procLocksHoldFlock(procLocks: string, pid: number, inode: number): boolean {
    return procLocks.split('\n').some((line) => {
        // "<n>: FLOCK  ADVISORY  WRITE <pid> <maj>:<min>:<inode> <start> <end>"; blocked waiters carry "->".
        const match = /^\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+(\d+)\s+[0-9a-f]+:[0-9a-f]+:(\d+)\s/.exec(line)
        return Boolean(match && Number(match[1]) === pid && Number(match[2]) === inode)
    })
}

export async function holdsWriterFlock(lockPath: string, pid = process.pid): Promise<boolean> {
    try {
        const [procLocks, info] = await Promise.all([readFile('/proc/locks', 'utf8'), stat(lockPath)])
        return procLocksHoldFlock(procLocks, pid, info.ino)
    } catch {
        return false
    }
}
