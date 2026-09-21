/** Internal process-group leader. Never imported by the app or public API. */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

if (!process.send || process.argv.length < 3) throw new Error('Supervisor requires its controller IPC channel.');

// Keep the group identity reserved after the workload exits and throughout
// graceful group termination. Only the controller releases this leader.
process.on('SIGTERM', () => {});
process.on('SIGINT', () => {});
let stopping = false;
process.on('message', (message) => {
    if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'stop' || stopping) return;
    stopping = true;
    void stopGroup();
});
process.on('disconnect', () => {
    // If the controller dies, this leader still owns its group: kill the group
    // while our own PID is necessarily alive. No persisted PID lookup involved.
    process.kill(-process.pid, 'SIGKILL');
});

async function workersRemain() {
    const probe = spawn('/bin/ps', ['-axo', 'pid=,pgid=,stat='], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    probe.stdout.setEncoding('utf8');
    probe.stdout.on('data', (text) => { output += text; });
    await new Promise((resolve, reject) => {
        probe.once('error', reject);
        probe.once('exit', (code) => code === 0 ? resolve(undefined) : reject(new Error('Process inspection failed.')));
    });
    const rows = output.trim().split('\n').map((line) => line.trim().split(/\s+/u));
    if (rows.some(([pid, pgid, state]) => !/^\d+$/u.test(pid) || !/^\d+$/u.test(pgid) || !state)) throw new Error('Invalid process inspection.');
    return rows.some(([pid, pgid, state]) => Number(pgid) === process.pid
        && Number(pid) !== process.pid && Number(pid) !== probe.pid && !state.startsWith('Z'));
}

async function stopGroup() {
    // All group signals originate here: this process is necessarily alive at
    // the syscall, so its PID/PGID cannot have been reassigned to another owner.
    process.kill(-process.pid, 'SIGTERM');
    try {
        const deadline = Date.now() + 5_000;
        while (await workersRemain() && Date.now() < deadline) await delay(50);
        if (!await workersRemain()) process.exit(0);
    } catch {
        // Ownership is still pinned by this supervisor. If graceful inspection
        // fails, terminate our own entire group instead of reporting success.
    }
    process.kill(-process.pid, 'SIGKILL');
}

const workload = spawn(process.execPath, process.argv.slice(2), {
    env: process.env, stdio: ['ignore', 'inherit', 'inherit'],
});
let reported = false;
/** @param {number | null} code @param {NodeJS.Signals | null} signal */
function report(code, signal) {
    if (reported) return;
    reported = true;
    process.send?.({ type: 'workloadExited', code, signal });
}
workload.once('error', () => report(1, null));
workload.once('exit', report);
process.send({ type: 'supervisorReady' });