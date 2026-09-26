import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), lstat: vi.fn(), open: vi.fn(), platform: vi.fn(), arch: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:fs/promises', () => ({ lstat: mocks.lstat, open: mocks.open }));
vi.mock('node:os', () => ({ platform: mocks.platform, arch: mocks.arch }));
import { launchWindowsSession, WindowsSessionLaunchError, windowsSessionReceiptSchema, verifyWindowsSessionLauncher, readWindowsSessionReceipt, probeWindowsProcessIdentity } from './windowsSessionLauncher';
const helper = Buffer.from('trusted helper');
const options = { helperPath: 'C:\\trusted\\launcher.exe', helperSha256: createHash('sha256').update(helper).digest('hex'),
    executable: 'C:\\trusted\\node.exe', args: ['C:\\trusted\\index.js', 'codex'], cwd: 'C:\\project', env: {},
    instanceId: 'instance-1', launchId: 'launch-1', receiptPath: 'C:\\private\\unique.json' };
let child: EventEmitter & { stdin: PassThrough; stdout: PassThrough; kill: ReturnType<typeof vi.fn> };
let files: Map<string, Buffer>;
const readyFrame = { version: 1, type: 'ready', launchId: 'launch-1', instanceId: 'instance-1', rootPid: 123 };
const finalFrame = { ...readyFrame, type: 'final', launched: true, resumed: true, rootExit: 0, jobEmpty: true, forced: false, ownerTerminated: false, nativeError: 0 };
function frame(value: unknown) { child.stdout.write(JSON.stringify(value) + '\n'); }
function durable(value: unknown) { files.set(options.receiptPath, Buffer.from(JSON.stringify(value) + '\n')); }
beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks(); mocks.platform.mockReturnValue('win32'); mocks.arch.mockReturnValue('x64');
    child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn() });
    mocks.spawn.mockReturnValue(child); files = new Map([[options.helperPath, helper]]);
    mocks.lstat.mockImplementation(async (path: string) => {
        const bytes = files.get(path); if (!bytes) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return { isFile: () => true, isSymbolicLink: () => false, nlink: 1, size: bytes.length, ino: 1, dev: 1 };
    });
    mocks.open.mockImplementation(async (path: string) => ({ stat: () => mocks.lstat(path), close: vi.fn(),
        read: async (buffer: Buffer) => { const bytes = files.get(path)!; bytes.copy(buffer); return { bytesRead: bytes.length }; } }));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
it('verifies the helper and keeps the root suspended until explicitly resumed', async () => {
    const launch = await launchWindowsSession(options);
    expect(mocks.spawn).toHaveBeenCalledWith(options.helperPath, expect.arrayContaining(['--receipt', options.receiptPath, '--', options.executable]),
        expect.objectContaining({ shell: false, detached: true, stdio: ['pipe', 'pipe', 'ignore'] }));
    expect(child.stdin.read()).toBeNull(); frame(readyFrame); expect(await launch.ready).toBe(123);
    await launch.resume(); expect(child.stdin.read()?.toString()).toBe('resume\n');
    frame(finalFrame); durable(finalFrame);
    let exited = false; void launch.exit.then(() => { exited = true; }); await Promise.resolve(); expect(exited).toBe(false);
    child.emit('close', 0, null); expect(await launch.exit).toEqual(finalFrame); expect(child.kill).not.toHaveBeenCalled();
});
it('rejects wrong digest and unverified architecture before creating a process', async () => {
    await expect(launchWindowsSession({ ...options, helperSha256: '0'.repeat(64) })).rejects.toMatchObject({ processCreated: false });
    mocks.arch.mockReturnValue('arm64'); await expect(launchWindowsSession(options)).rejects.toBeInstanceOf(WindowsSessionLaunchError);
    expect(mocks.spawn).not.toHaveBeenCalled();
});
it('never treats helper exit zero as proof without the durable final receipt', async () => {
    const launch = await launchWindowsSession(options); frame(readyFrame); await launch.resume(); frame(finalFrame);
    child.emit('close', 0, null); await expect(launch.exit).rejects.toThrow(); expect(child.kill).not.toHaveBeenCalled();
});
it('rejects a substituted durable receipt even when stdout claims success', async () => {
    const launch = await launchWindowsSession(options); frame(readyFrame); await launch.resume(); frame(finalFrame);
    durable({ ...finalFrame, launchId: 'different-launch' }); child.emit('close', 0, null);
    await expect(launch.exit).rejects.toThrow('receipt identity mismatch');
});
it('preserves nonzero ordinary root exit evidence without claiming clean drain', async () => {
    const launch = await launchWindowsSession(options); frame(readyFrame); await launch.resume();
    const failed = { ...finalFrame, rootExit: 7 }; frame(failed); durable(failed); child.emit('close', 125, null);
    expect(await launch.exit).toMatchObject({ rootExit: 7, jobEmpty: true });
});
it('returns a durable no-process receipt independently of readiness rejection', async () => {
    const launch = await launchWindowsSession(options);
    const failed = { ...finalFrame, launched: false, resumed: false, rootPid: 0, rootExit: null, jobEmpty: false, nativeError: 2 };
    frame(failed); durable(failed); child.emit('close', 125, null);
    await expect(launch.ready).rejects.toThrow('not launched'); expect(await launch.exit).toEqual(failed);
});
it('fails closed on lost native observation after resume without killing or ending stdin', async () => {
    const launch = await launchWindowsSession(options); frame(readyFrame); await launch.resume();
    child.stdout.write('malformed\n'); await expect(launch.exit).rejects.toThrow('Invalid native launcher frame');
    expect(child.stdin.writableEnded).toBe(false); expect(child.kill).not.toHaveBeenCalled();
});
it('retains late readiness and durable rollback evidence after startup timeout', async () => {
    const launch = await launchWindowsSession(options); await vi.advanceTimersByTimeAsync(10_000);
    await expect(launch.ready).rejects.toThrow('readiness timeout');
    expect(child.stdin.writableEnded).toBe(true); expect(child.kill).not.toHaveBeenCalled();
    frame(readyFrame);
    await expect(launch.resume()).rejects.toThrow('cannot resume');
    const rollback = { ...finalFrame, resumed: false, forced: true, rootExit: 125, nativeError: -1 };
    frame(rollback); durable(rollback); child.emit('close', 125, null);
    expect(await launch.exit).toEqual(rollback);
    await expect(launch.ready).rejects.toThrow('readiness timeout');
});
it('rejects impossible native process and Job evidence', () => {
    expect(windowsSessionReceiptSchema.safeParse({ ...finalFrame, jobEmpty: false }).success).toBe(false);
    expect(windowsSessionReceiptSchema.safeParse({ ...finalFrame, launched: false }).success).toBe(false);
});
it('rejects duplicate readiness and oversized native frames without resuming a root', async () => {
    const launch = await launchWindowsSession(options); frame(readyFrame); frame(readyFrame);
    await expect(launch.exit).rejects.toThrow('Invalid native launcher frame');
    await expect(launch.resume()).rejects.toThrow('cannot resume'); expect(child.kill).not.toHaveBeenCalled();
});

it('preflights the helper without creating a process or a receipt', async () => {
    await verifyWindowsSessionLauncher(options);
    expect(mocks.spawn).not.toHaveBeenCalled(); expect(files.size).toBe(1);
    await expect(verifyWindowsSessionLauncher({ ...options, helperSha256: '0'.repeat(64) })).rejects.toThrow('digest mismatch');
});
it('cancels a suspended root while retaining its durable rollback evidence', async () => {
    const launch = await launchWindowsSession(options); frame(readyFrame); await launch.ready;
    launch.cancelBeforeResume(); expect(child.stdin.writableEnded).toBe(true);
    await expect(launch.resume()).rejects.toThrow('cannot resume');
    const rollback = { ...finalFrame, resumed: false, forced: true, rootExit: 125, nativeError: -1 };
    frame(rollback); durable(rollback); child.emit('close', 125, null);
    expect(await launch.exit).toEqual(rollback); expect(child.kill).not.toHaveBeenCalled();
});
it('never cancels or closes the pipe of a resumed root', async () => {
    const launch = await launchWindowsSession(options); frame(readyFrame); await launch.resume();
    launch.cancelBeforeResume(); expect(child.stdin.writableEnded).toBe(false);
    frame(finalFrame); durable(finalFrame); child.emit('close', 0, null);
    expect(await launch.exit).toEqual(finalFrame); expect(child.kill).not.toHaveBeenCalled();
});

it('preserves rollback observation when cancelled before readiness arrives', async () => {
    const launch = await launchWindowsSession(options); launch.cancelBeforeResume();
    await expect(launch.ready).rejects.toThrow('cancelled before resume');
    frame(readyFrame);
    const rollback = { ...finalFrame, resumed: false, forced: true, rootExit: 125, nativeError: -1 };
    frame(rollback); durable(rollback); child.emit('close', 125, null);
    expect(await launch.exit).toEqual(rollback); expect(child.kill).not.toHaveBeenCalled();
});

it('requires explicit resumed-owner termination and sends the private command only once', async () => {
    const launch = await launchWindowsSession(options);
    await expect(launch.terminate()).rejects.toThrow('cannot terminate');
    frame(readyFrame); await launch.resume(); expect(child.stdin.read()?.toString()).toBe('resume\n');
    const first = launch.terminate(); const second = launch.terminate(); expect(second).toBe(first); await first;
    expect(child.stdin.read()?.toString()).toBe('terminate\n');
    const stopped = { ...finalFrame, ownerTerminated: true, rootExit: 125 };
    frame(stopped); durable(stopped); child.emit('close', 125, null);
    expect(await launch.exit).toEqual(stopped); expect(child.kill).not.toHaveBeenCalled();
});
it('rejects clean-exit claims for an explicitly owner-terminated Job', async () => {
    const launch = await launchWindowsSession(options); frame(readyFrame); await launch.resume(); await launch.terminate();
    const stopped = { ...finalFrame, ownerTerminated: true };
    frame(stopped); durable(stopped); child.emit('close', 0, null);
    await expect(launch.exit).rejects.toThrow('status mismatch');
});
it('recovers bounded immutable receipts only for their expected identities', async () => {
    durable(finalFrame);
    expect(await readWindowsSessionReceipt(options.receiptPath, options)).toEqual(finalFrame);
    await expect(readWindowsSessionReceipt(options.receiptPath, { ...options, launchId: 'other' })).rejects.toThrow('identity mismatch');
    durable({ ...finalFrame, ownerTerminated: true, resumed: false });
    await expect(readWindowsSessionReceipt(options.receiptPath, options)).rejects.toThrow();
});

it('probes a verified process identity without losing FILETIME precision', async () => {
    const result = probeWindowsProcessIdentity(options, 123);
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
    expect(mocks.spawn).toHaveBeenCalledWith(options.helperPath, ['--process-identity', '123'], expect.objectContaining({ shell: false, stdio: ['ignore', 'pipe', 'ignore'] }));
    frame({ version: 1, type: 'process-identity', status: 'present', pid: 123, creationFileTime: '134346492567582393' });
    child.emit('close', 0, null);
    expect(await result).toEqual({ status: 'present', pid: 123, creationFileTime: '134346492567582393' });
});
it.each([
    { version: 1, type: 'process-identity', status: 'gone', pid: 123, nativeError: 5 },
    { version: 1, type: 'process-identity', status: 'unknown', pid: 123, nativeError: 5 },
    { version: 1, type: 'process-identity', status: 'present', pid: 123, creationFileTime: '0' },
    { version: 1, type: 'process-identity', status: 'present', pid: 123, creationFileTime: '01' },
    { version: 1, type: 'process-identity', status: 'present', pid: 124, creationFileTime: '134346492567582393' },
    { version: 1, type: 'process-identity', status: 'present', pid: 123, creationFileTime: 134346492567582393 },
    { version: 1, type: 'process-identity', status: 'present', pid: 123, creationFileTime: '18446744073709551616' },
])('rejects invalid process identity evidence %j', async value => {
    const result = probeWindowsProcessIdentity(options, 123);
    const rejected = expect(result).rejects.toThrow();
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
    frame(value); child.emit('close', 0, null); await rejected;
    expect(child.kill).not.toHaveBeenCalled();
});
it('rejects nonexistent PID error 87 as unknown rather than death proof', async () => {
    const result = probeWindowsProcessIdentity(options, 123);
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
    const rejected = expect(result).rejects.toThrow();
    frame({ version: 1, type: 'process-identity', status: 'unknown', pid: 123, nativeError: 87 });
    child.emit('close', 125, null); await rejected;
});
it('keeps timed-out identity probes unknown without terminating the target', async () => {
    const result = probeWindowsProcessIdentity(options, 123);
    const rejected = expect(result).rejects.toThrow('timeout');
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(5000); await rejected;
    expect(child.kill).not.toHaveBeenCalled();
});

it('requires successful helper exit and exactly one bounded identity frame', async () => {
    const result = probeWindowsProcessIdentity(options, 123);
    const rejected = expect(result).rejects.toThrow();
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
    frame({ version: 1, type: 'process-identity', status: 'gone', pid: 123, nativeError: 87 });
    child.emit('close', 125, null); await rejected;
});
it('rejects excess probe output without killing the target or helper', async () => {
    const result = probeWindowsProcessIdentity(options, 123);
    const rejected = expect(result).rejects.toThrow();
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
    child.stdout.write('x'.repeat(1025)); await rejected; expect(child.kill).not.toHaveBeenCalled();
});
