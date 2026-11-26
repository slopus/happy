/** Owner-installed programs, scoped to this server/account and exact task. No shell or input interpolation.
 * Programs run as the daemon OS user, NOT under an AI sandbox. The local registry is the explicit grant.
 * Persist intent before spawning and results before reporting. Unknown delivery is never replayed. */
import { spawn } from 'node:child_process';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { type ScheduledRun, type ScheduledRunReport, type ScheduledTaskConfig, ScheduledRunReportSchema } from '@slopus/happy-wire';
import { writeScheduleJournalFile } from './journal';

const programSchema = z.object({ taskId: z.string().uuid(), directory: z.string(), executable: z.string(),
    args: z.array(z.string().max(4096)).max(32), timeoutMs: z.number().int().min(100).max(7200000) }).strict();
const registrySchema = z.object({ handlers: z.record(z.string(), programSchema) }).strict();
type Receipt = { run: Pick<ScheduledRun, 'id' | 'taskId' | 'claimId'>; report: ScheduledRunReport; acknowledged?: boolean; rejection?: string };
type ReportResult = Pick<ScheduledRun, 'id' | 'claimId' | 'status'>;

export function createLocalTaskHandler(directory: string, report: (run: Receipt['run'], value: ScheduledRunReport) => Promise<ReportResult>,
    diagnose: (id: string, reason: string) => void = () => {}) {
    const active = new Map<string, () => void>();
    const executing = new Set<string>();
    let stopping = false;
    const file = (id: string): string => `local-${z.string().uuid().parse(id)}.json`;
    const save = (receipt: Receipt): void => writeScheduleJournalFile(directory, file(receipt.run.id), receipt);
    async function read(id: string): Promise<Receipt | null> {
        let raw: string;
        try { raw = await readFile(join(directory, file(id)), 'utf8'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
        const value = JSON.parse(raw) as Receipt;
        z.object({ id: z.literal(id), taskId: z.string().uuid(), claimId: z.string().uuid() }).parse(value.run);
        ScheduledRunReportSchema.parse(value.report);
        if (value.report.claimId !== value.run.claimId) throw new Error('Invalid local task receipt');
        return value;
    }
    async function recover(receipt: Receipt): Promise<void> {
        if (receipt.acknowledged) return;
        if (receipt.report.status === 'running') {
            receipt.report = { claimId: receipt.run.claimId!, status: 'uncertain', sequence: 2, reason: 'local-handler-interrupted' };
            save(receipt);
        }
        await deliverReceipt(receipt);
    }
    async function deliverReceipt(receipt: Receipt): Promise<void> {
        try {
            const result = await report(receipt.run, receipt.report);
            if (result.id !== receipt.run.id || result.claimId !== receipt.run.claimId) throw new Error('Invalid report acknowledgement');
            receipt.acknowledged = true;
            if (result.status !== receipt.report.status) receipt.rejection = 'remote-state-changed';
            save(receipt);
        } catch (error) {
            const status = (error as { response?: { status?: number } }).response?.status;
            if (status !== 403 && status !== 404) throw error;
            receipt.acknowledged = true; receipt.rejection = `report-rejected-${status}`; save(receipt);
            diagnose(receipt.run.id, receipt.rejection);
        }
    }
    return {
        async flush(): Promise<void> {
            let names: string[];
            try { names = await readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
            for (const name of names.filter(name => /^local-[a-f0-9-]{36}\.json$/.test(name))) {
                const id = name.slice(6, -5);
                if (executing.has(id)) continue;
                // One corrupt, stale or offline receipt must not block unrelated work.
                // Keep corrupt files in place: absence must never authorize a replay.
                try { const receipt = await read(id); if (receipt) await recover(receipt); }
                catch { diagnose(id, 'receipt-recovery-failed'); }
            }
        },
        stop(): void { stopping = true; for (const stop of active.values()) stop(); },
        async execute(run: ScheduledRun, config: ScheduledTaskConfig): Promise<void> {
            if (stopping || executing.has(run.id)) return;
            executing.add(run.id);
            try {
            const prior = await read(run.id);
            if (prior) { await recover(prior); return; }
            const receipt: Receipt = { run: { id: run.id, taskId: run.taskId, claimId: run.claimId }, report: { claimId: run.claimId!, status: 'running', sequence: 1 } };
            let program: z.infer<typeof programSchema>;
            try {
                const registryPath = join(directory, 'handlers.json');
                const info = await lstat(registryPath);
                if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error('Private registry required');
                const registry = registrySchema.parse(JSON.parse(await readFile(registryPath, 'utf8')));
                program = programSchema.parse(registry.handlers[config.localHandlerId ?? '']);
                if (program.taskId !== run.taskId || !isAbsolute(program.executable) || !isAbsolute(program.directory)
                    || await realpath(program.directory) !== await realpath(config.directory)) throw new Error('Task is not registered');
                await realpath(program.executable);
            } catch {
                receipt.report = { claimId: run.claimId!, status: 'failed', reason: 'local-handler-not-registered', sequence: 2 };
                save(receipt); await deliverReceipt(receipt); return;
            }
            save(receipt);
            // If this call is uncertain, no child starts; recovery still conservatively refuses replay.
            const authorization = await report(receipt.run, receipt.report);
            if (authorization.id !== run.id || authorization.claimId !== run.claimId || authorization.status !== 'running') {
                receipt.acknowledged = true; receipt.rejection = 'start-not-authorized'; save(receipt); return;
            }
            if (stopping) { await recover(receipt); return; }
            const result = await new Promise<'completed' | 'failed' | 'uncertain'>(resolve => {
                // Intentionally omit inherited Paws/account credentials and Node injection options.
                const names = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS'];
                const env = Object.fromEntries(names.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]!]));
                const child = spawn(program.executable, program.args, { cwd: program.directory, env, shell: false,
                    detached: process.platform !== 'win32', stdio: ['pipe', 'ignore', 'ignore'] });
                let stopped = false, failed = false, hardKill: ReturnType<typeof setTimeout> | undefined;
                const kill = (signal: NodeJS.Signals): void => { try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Already exited. */ } };
                const stop = (): void => { stopped = true; kill('SIGTERM'); hardKill ??= setTimeout(() => kill('SIGKILL'), 1500); };
                active.set(run.id, stop);
                const deadline = setTimeout(stop, program.timeoutMs);
                child.on('error', () => { failed = true; });
                child.stdin.on('error', () => { /* Exit event determines outcome. */ });
                child.stdin.end(JSON.stringify({ taskId: run.taskId, runId: run.id, input: run.webhookInput ?? {} }));
                child.on('close', code => {
                    clearTimeout(deadline); if (hardKill) clearTimeout(hardKill);
                    if (stopped || failed || code !== 0) kill('SIGKILL');
                    active.delete(run.id);
                    resolve(stopped ? 'uncertain' : !failed && code === 0 ? 'completed' : 'failed');
                });
            });
            receipt.report = { claimId: run.claimId!, status: result, sequence: 2,
                ...(result !== 'completed' ? { reason: result === 'uncertain' ? 'local-handler-interrupted' : 'local-handler-failed' } : {}) };
            save(receipt);
            await deliverReceipt(receipt);
            } finally { executing.delete(run.id); }
        },
    };
}
