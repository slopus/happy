/** Read-only lifetime evidence for an authenticated unsent candidate; never signals processes. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
export type NativeProcessIdentity = { pid: number; ppid: number; pgid: number; startedAt: string };
export type NativeProcessTree = { rootPid: number; processes: NativeProcessIdentity[] };
export class NativeProcessTreeIdentityError extends Error {
    constructor(readonly reason: 'root-reused' | 'new-descendant', readonly observed: NativeProcessIdentity[]) {
        super(reason === 'root-reused' ? 'The captured candidate host PID was reused; cancellation is unconfirmed.'
            : 'A new native descendant appeared during retirement; cancellation is unconfirmed.');
    }
}

function parse(table: string): NativeProcessIdentity[] {
    const rows: NativeProcessIdentity[] = []; const seen = new Set<number>();
    for (const line of table.trim().split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
        if (!match) throw new Error('Native process lifetime evidence is incomplete.');
        const [pid, ppid, pgid] = match.slice(1, 4).map(Number);
        const startedAt = match[4].replace(/\s+/g, ' ');
        if (![pid, ppid, pgid].every(Number.isSafeInteger) || pid <= 0 || ppid < 0 || pgid < 0
            || !Number.isFinite(Date.parse(startedAt)) || seen.has(pid)) throw new Error('Native process lifetime evidence is ambiguous.');
        seen.add(pid); rows.push({ pid, ppid, pgid, startedAt });
    }
    return rows.sort((a, b) => a.pid - b.pid);
}

function descendants(seeds: Set<number>, rows: NativeProcessIdentity[]): Set<number> {
    const result = new Set(seeds);
    for (;;) {
        const size = result.size;
        for (const row of rows) if (result.has(row.ppid)) result.add(row.pid);
        if (size === result.size) return result;
    }
}

export function nativeProcessTreeFromTable(pid: number, table: string): NativeProcessTree {
    const rows = parse(table); const root = rows.find(row => row.pid === pid);
    if (!root || root.pgid !== pid) throw new Error('The authenticated candidate host lifetime cannot be captured.');
    const owned = descendants(new Set([pid]), rows);
    const processes = rows.filter(row => owned.has(row.pid));
    // Unrelated Linux kernel rows may use PGID 0; authenticated lifetime
    // evidence still requires a positive process group for every member.
    if (processes.some(row => row.pgid <= 0)) throw new Error('The authenticated candidate descendant lifetime cannot be captured.');
    return { rootPid: pid, processes };
}

export function sameNativeProcessTree(a: NativeProcessTree, b: NativeProcessTree): boolean {
    // A daemon restart can reparent the detached host; its external parent is
    // not a member of the authenticated subtree. Descendant parentage matters.
    const comparable = (tree: NativeProcessTree) => tree.processes.map(row => ({ ...row, ppid: row.pid === tree.rootPid ? 0 : row.ppid }));
    return a.rootPid === b.rootPid && JSON.stringify(comparable(a)) === JSON.stringify(comparable(b));
}

export function nativeProcessTreeHasExited(tree: NativeProcessTree, table: string): boolean {
    const rows = parse(table); const original = new Map(tree.processes.map(row => [row.pid, row]));
    const root = original.get(tree.rootPid); if (!root) throw new Error('Captured candidate host evidence is missing.');
    const currentRoot = rows.find(row => row.pid === tree.rootPid);
    if (currentRoot && currentRoot.startedAt !== root.startedAt) throw new NativeProcessTreeIdentityError('root-reused', [currentRoot]);
    const alive = rows.filter(row => original.get(row.pid)?.startedAt === row.startedAt);
    const observed = descendants(new Set(alive.map(row => row.pid)), rows);
    if (rows.some(row => observed.has(row.pid) && row.pgid <= 0)) throw new Error('Native process lifetime evidence is ambiguous.');
    const additional = rows.filter(row => observed.has(row.pid) && original.get(row.pid)?.startedAt !== row.startedAt);
    if (additional.length) throw new NativeProcessTreeIdentityError('new-descendant', additional);
    // A same-second reuse remains conservatively alive. Reparenting or exec
    // also cannot turn a captured lifetime into an exit.
    return alive.length === 0;
}

async function readTable(): Promise<string> {
    const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], {
        timeout: 3000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    });
    if (!parse(stdout).some(row => row.pid === process.pid)) throw new Error('The native process table is incomplete.');
    return stdout;
}

export async function captureNativeProcessTree(pid: number): Promise<NativeProcessTree> {
    return nativeProcessTreeFromTable(pid, await readTable());
}

/** Bounded local lifetime observation only; no relay queries, signals or effect retries. */
export async function awaitNativeProcessTreeExit(tree: NativeProcessTree): Promise<void> {
    const deadline = Date.now() + 5000;
    for (;;) {
        if (nativeProcessTreeHasExited(tree, await readTable())) return;
        if (Date.now() >= deadline) throw new Error('Captured native process lifetimes remain alive; cancellation is pending.');
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}
