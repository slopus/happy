import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

/** Daemon regular workers are detached group leaders. Never signal a PID group. */
export function hasIsolatedNativeProcessGroup(pid: number, table: string): boolean {
    const rows = table.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number))
        .filter(row => row.length === 3 && row.every(Number.isSafeInteger));
    const root = rows.find(row => row[0] === pid);
    if (!root || root[2] !== pid) return false;
    const descendants = new Set([pid]);
    for (;;) {
        const before = descendants.size;
        for (const [id, parent] of rows) if (descendants.has(parent)) descendants.add(id);
        if (before === descendants.size) break;
    }
    return rows.every(([id, , group]) => !descendants.has(id) || group === pid);
}
export async function verifyNativeProcessGroup(pid: number): Promise<boolean> {
    const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,pgid='], { timeout: 3000, maxBuffer: 2 * 1024 * 1024 });
    return hasIsolatedNativeProcessGroup(pid, stdout);
}
/** A bounded local process-exit wait, without querying any relay/task status. */
export async function awaitNativeProcessGroupExit(pid: number): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt++) {
        try { process.kill(-pid, 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error; }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('The previous native process group has not exited; its thread was not resumed.');
}
