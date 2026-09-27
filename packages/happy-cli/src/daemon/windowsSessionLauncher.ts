import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { platform, arch } from 'node:os';
import { win32 } from 'node:path';
import { z } from 'zod';

const identity = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const uint = z.number().int().min(0).max(0xffffffff);
export const windowsSessionReceiptSchema = z.object({
    version: z.literal(1), type: z.literal('final'), launchId: identity, instanceId: identity,
    launched: z.boolean(), resumed: z.boolean(), rootPid: uint,
    rootExit: uint.nullable(), jobEmpty: z.boolean(), forced: z.boolean(), ownerTerminated: z.boolean(), nativeError: z.number().int(),
}).strict().superRefine((value, context) => {
    if ((!value.launched && (value.resumed || value.rootPid !== 0 || value.rootExit !== null || value.forced || value.ownerTerminated)) ||
        (value.launched && (value.rootPid === 0 || value.rootExit === null || !value.jobEmpty)) ||
        (value.resumed && value.forced) || (value.ownerTerminated && (!value.resumed || value.forced))) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Inconsistent native receipt' });
});
export type WindowsSessionReceipt = z.infer<typeof windowsSessionReceiptSchema>;
const readySchema = z.object({ version: z.literal(1), type: z.literal('ready'), launchId: identity,
    instanceId: identity, rootPid: uint.refine(value => value > 0) }).strict();
export type WindowsSessionLaunchOptions = {
    helperPath: string; helperSha256: string; executable: string; args: string[];
    cwd: string; env: NodeJS.ProcessEnv; instanceId: string; launchId: string; receiptPath: string;
};
export type WindowsSessionLaunch = {
    child: ChildProcess; ready: Promise<number>; resume(): Promise<void>; terminate(): Promise<void>; cancelBeforeResume(): void; exit: Promise<WindowsSessionReceipt>;
};
function absolute(value: string): boolean {
    return /^[a-z]:\\/i.test(value) && !value.includes('\0') && !value.slice(2).includes(':') &&
        win32.normalize(value).toLowerCase() === value.toLowerCase();
}
async function readRegular(path: string, limit: number): Promise<Buffer> {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit) throw new Error('Unsafe native evidence file');
    const file = await open(path, 'r');
    try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit || stat.ino !== before.ino || stat.dev !== before.dev) throw new Error('Native evidence file changed');
        const bytes = Buffer.alloc(limit + 1);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead > limit || bytesRead !== stat.size) throw new Error('Invalid native evidence size');
        return bytes.subarray(0, bytesRead);
    } finally { await file.close(); }
}
/** Recovery-only evidence reader. Caller must first validate the receipt directory ACL and
 * every ancestor against the protected native observation root. Job-empty evidence is permanent;
 * this function neither looks up a PID nor grants permission to terminate any process.
 */
export async function readWindowsSessionReceipt(receiptPath: string, expected: { instanceId: string; launchId: string }): Promise<WindowsSessionReceipt> {
    identity.parse(expected.instanceId); identity.parse(expected.launchId);
    const receipt = windowsSessionReceiptSchema.parse(JSON.parse((await readRegular(receiptPath, 4096)).toString('utf8')));
    if (receipt.instanceId !== expected.instanceId || receipt.launchId !== expected.launchId) throw new Error('Native receipt identity mismatch');
    return receipt;
}
/** Owner must protect all helper/receipt ancestors from mutation and allocate a unique receipt path.
 * This adapter never kills a helper or a running Job. Losing observation is a failure, not exit proof.
 */
export class WindowsSessionLaunchError extends Error {
    readonly processCreated = false;
}
export async function launchWindowsSession(options: WindowsSessionLaunchOptions): Promise<WindowsSessionLaunch> {
    let created = false;
    try { return await prepareWindowsSession(options, () => { created = true; }); }
    catch (error) {
        if (created) throw error;
        throw new WindowsSessionLaunchError(error instanceof Error ? error.message : 'Native launch preparation failed');
    }
}
/** Read-only capability preflight. The owner protects the artifact and all its ancestors from mutation. */
export async function verifyWindowsSessionLauncher(options: Pick<WindowsSessionLaunchOptions, 'helperPath' | 'helperSha256'>): Promise<void> {
    if (platform() !== 'win32' || arch() !== 'x64') throw new Error('Verified Windows x64 launcher required');
    if (!absolute(options.helperPath) || !/\.exe$/i.test(options.helperPath) || !/^[a-f0-9]{64}$/i.test(options.helperSha256)) throw new Error('Invalid native helper configuration');
    const helper = await readRegular(options.helperPath, 32 * 1024 * 1024);
    if (createHash('sha256').update(helper).digest('hex') !== options.helperSha256.toLowerCase()) throw new Error('Native launcher digest mismatch');
}
export type WindowsProcessIdentity = { pid: number; creationFileTime: string };
const processIdentityFrame = z.object({ version: z.literal(1), type: z.literal('process-identity'), status: z.literal('present'), pid: uint.min(1),
        creationFileTime: z.string().regex(/^[1-9][0-9]{0,19}$/).refine(value => BigInt(value) <= 18446744073709551615n) }).strict();
/** Read-only PID incarnation observation. Failure is unknown, never process-exit evidence. */
export async function probeWindowsProcessIdentity(options: Pick<WindowsSessionLaunchOptions, 'helperPath' | 'helperSha256'>, pid: number): Promise<
    { status: 'present' } & WindowsProcessIdentity
> {
    uint.min(1).parse(pid);
    await verifyWindowsSessionLauncher(options);
    return new Promise((resolve, reject) => {
        const child = spawn(options.helperPath, ['--process-identity', String(pid)],
            { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        let output = '', bytes = 0, settled = false;
        const finish = (error?: Error) => {
            if (settled) return false;
            settled = true; clearTimeout(timer);
            if (error) { child.stdout?.destroy(); child.unref?.(); reject(error); }
            return true;
        };
        const timer = setTimeout(() => finish(new Error('Native process identity timeout')), 5000);
        child.once('error', () => finish(new Error('Native process identity unavailable')));
        child.stdout?.on('error', () => finish(new Error('Native process identity unavailable')));
        child.stdout?.on('data', (chunk: Buffer) => {
            if (settled) return;
            bytes += chunk.length;
            if (bytes > 1024) { finish(new Error('Invalid native process identity')); return; }
            output += chunk.toString('utf8');
        });
        child.once('close', (code, signal) => {
            if (settled) return;
            try {
                if (code !== 0 || signal || !/^[^\r\n]+\r?\n$/.test(output)) throw new Error();
                const frame = processIdentityFrame.parse(JSON.parse(output));
                if (frame.pid !== pid) throw new Error();
                if (finish()) resolve({ status: frame.status, pid, creationFileTime: frame.creationFileTime });
            } catch { finish(new Error('Invalid native process identity')); }
        });
    });
}
async function prepareWindowsSession(options: WindowsSessionLaunchOptions, markCreated: () => void): Promise<WindowsSessionLaunch> {
    identity.parse(options.instanceId); identity.parse(options.launchId);
    if (![options.executable, options.cwd, options.receiptPath].every(absolute) ||
        !/\.exe$/i.test(options.executable) || options.args.some(arg => arg.includes('\0'))) throw new Error('Invalid native launch configuration');
    await verifyWindowsSessionLauncher(options);
    for (const file of [options.receiptPath, options.receiptPath + '.pending']) {
        try { await lstat(file); throw new Error('Native receipt path already exists'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const child = spawn(options.helperPath, ['--launch-id', options.launchId, '--instance-id', options.instanceId,
        '--receipt', options.receiptPath, '--', options.executable, ...options.args],
    // libuv otherwise puts this observer in its parent's kill-on-close Job on Windows.
    { cwd: options.cwd, env: options.env, shell: false, detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    markCreated();
    let resolveReady!: (pid: number) => void, rejectReady!: (error: Error) => void;
    let resolveExit!: (receipt: WindowsSessionReceipt) => void, rejectExit!: (error: Error) => void;
    const ready = new Promise<number>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const exit = new Promise<WindowsSessionReceipt>((resolve, reject) => { resolveExit = resolve; rejectExit = reject; });
    // The owner may await readiness first; retain exit rejection until it installs its observer.
    void ready.catch(() => {}); void exit.catch(() => {});
    let rootPid: number | undefined, resumed = false, cancelled = false, final: WindowsSessionReceipt | undefined, broken = false;
    let pending = Buffer.alloc(0), total = 0;
    let termination: Promise<void> | undefined;
    const fail = (error: Error) => {
        broken = true; rejectReady(error); rejectExit(error);
        // EOF rolls back only the helper's still-suspended owned root. Never kill a running Job.
        if (!resumed) child.stdin?.end();
    };
    const cancelSuspended = (error: Error) => {
        if (resumed || cancelled) return;
        cancelled = true;
        rejectReady(error);
        child.stdin?.end();
        // Keep reading the helper: its final durable receipt can prove the suspended rollback.
    };
    const startupTimer = setTimeout(() => cancelSuspended(new Error('Native launcher readiness timeout')), 10_000);
    startupTimer.unref();
    child.stdin?.on('error', () => {
        const error = new Error('Native launcher input failed');
        if (resumed) fail(error); else cancelSuspended(error);
    });
    child.on('error', () => { clearTimeout(startupTimer); fail(new Error('Native launcher process failed')); });
    child.stdout?.on('data', (chunk: Buffer) => {
        if (broken) return;
        total += chunk.length;
        if (total > 8192) { fail(new Error('Native launcher output exceeded limit')); return; }
        pending = Buffer.concat([pending, chunk]);
        let end: number;
        while ((end = pending.indexOf(10)) >= 0) {
            const line = pending.subarray(0, end).toString('utf8'); pending = pending.subarray(end + 1);
            try {
                const value: unknown = JSON.parse(line);
                const readyFrame = readySchema.safeParse(value);
                if (readyFrame.success) {
                    const frame = readyFrame.data;
                    if (rootPid !== undefined || final || frame.launchId !== options.launchId || frame.instanceId !== options.instanceId) throw new Error();
                    rootPid = frame.rootPid; clearTimeout(startupTimer); resolveReady(rootPid);
                } else {
                    const frame = windowsSessionReceiptSchema.parse(value);
                    if (final || frame.launchId !== options.launchId || frame.instanceId !== options.instanceId ||
                        (frame.launched && frame.rootPid !== rootPid) || (!frame.launched && rootPid !== undefined) ||
                        frame.resumed !== resumed) throw new Error();
                    final = frame;
                }
            } catch { fail(new Error('Invalid native launcher frame')); return; }
        }
    });
    child.on('close', (code, signal) => {
        clearTimeout(startupTimer);
        void (async () => {
            if (broken) return;
            if (pending.length || !final || signal || (code !== 0 && code !== 125)) throw new Error('Native launcher exited without final evidence');
            const receipt = await readWindowsSessionReceipt(options.receiptPath, options);
            if (JSON.stringify(receipt) !== JSON.stringify(final)) throw new Error('Native receipt mismatch');
            const clean = receipt.launched && receipt.resumed && receipt.rootExit === 0 && receipt.jobEmpty && !receipt.forced && !receipt.ownerTerminated && receipt.nativeError === 0;
            if ((code === 0) !== clean) throw new Error('Native launcher status mismatch');
            if (rootPid === undefined) rejectReady(new Error('Native child was not launched'));
            resolveExit(receipt);
        })().catch(error => fail(error instanceof Error ? error : new Error('Invalid native evidence')));
    });
    return { child, ready, exit, terminate: () => {
        if (termination) return termination;
        if (broken || !resumed || final || !child.stdin?.writable) return Promise.reject(new Error('Native root cannot terminate'));
        termination = new Promise<void>((resolve, reject) => child.stdin!.write('terminate\n', error => {
            if (error) { fail(new Error('Native termination delivery failed')); reject(error); } else resolve();
        }));
        return termination;
    }, cancelBeforeResume: () => {
        clearTimeout(startupTimer);
        cancelSuspended(new Error('Native launch cancelled before resume'));
    }, resume: async () => {
        if (broken || cancelled || rootPid === undefined || resumed || final || !child.stdin?.writable) throw new Error('Native root cannot resume');
        // Mark before writing: an I/O error can happen after bytes reach the helper.
        resumed = true;
        await new Promise<void>((resolve, reject) => child.stdin!.write('resume\n', error => {
            if (error) { fail(new Error('Native resume delivery failed')); reject(error); } else resolve();
        }));
    } };
}
