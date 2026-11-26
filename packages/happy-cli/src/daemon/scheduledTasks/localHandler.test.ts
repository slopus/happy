import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLocalTaskHandler } from './localHandler';
import type { ScheduledRun, ScheduledRunReport, ScheduledTaskConfig } from '@slopus/happy-wire';

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'paws-local-task-'));
    const taskId = randomUUID();
    const config: ScheduledTaskConfig = { title: 'trusted program', prompt: 'unused', agent: 'codex', permissionMode: 'read-only', directory, localHandlerId: 'cards' };
    const run = { id: randomUUID(), taskId, claimId: randomUUID(), executionKind: 'local-handler', webhookInput: { value: '$(touch SHOULD_NOT_EXIST); ../../escape' } } as unknown as ScheduledRun;
    const reports: ScheduledRunReport[] = [];
    const script = join(directory, 'program.cjs');
    await writeFile(script, "let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>require('fs').writeFileSync('received.json',s));");
    const registry = { handlers: { cards: { taskId, directory, executable: process.execPath, args: [script], timeoutMs: 5000 } } };
    await writeFile(join(directory, 'handlers.json'), JSON.stringify(registry), { mode: 0o600 });
    const handler = createLocalTaskHandler(directory, async (run, report) => { reports.push(report); return { id: run.id, claimId: run.claimId, status: report.status }; });
    return { directory, taskId, config, run, reports, registry, handler };
}

describe('registered local tasks', () => {
    it('executes only the registered program with external values passed literally on stdin, once', async () => {
        const f = await fixture();
        await f.handler.execute(f.run, f.config);
        const input = JSON.parse(await readFile(join(f.directory, 'received.json'), 'utf8'));
        expect(input).toEqual({ taskId: f.taskId, runId: f.run.id, input: f.run.webhookInput });
        expect(f.reports.map(r => r.status)).toEqual(['running', 'completed']);
        await f.handler.execute(f.run, f.config);
        expect(f.reports.at(-1)?.status).toBe('completed');
        expect(f.reports.filter(r => r.status === 'running')).toHaveLength(1);
    });
    it('rejects other tasks and directories and public registry files without execution', async () => {
        for (const change of ['task', 'directory', 'mode']) {
            const f = await fixture();
            if (change === 'task') f.run.taskId = randomUUID();
            if (change === 'directory') f.config.directory = tmpdir();
            if (change === 'mode') await chmod(join(f.directory, 'handlers.json'), 0o644);
            await f.handler.execute(f.run, f.config);
            expect(f.reports.map(r => r.status)).toEqual(['failed']);
            await expect(readFile(join(f.directory, 'received.json'))).rejects.toThrow();
        }
    });
    it('flushes a persisted terminal receipt after a report failure without repeating the child', async () => {
        const f = await fixture();
        const first = createLocalTaskHandler(f.directory, async (run, report) => { if (report.status === 'completed') throw new Error('network lost'); return { id: run.id, claimId: run.claimId, status: report.status }; });
        await expect(first.execute(f.run, f.config)).rejects.toThrow('network lost');
        const before = await readFile(join(f.directory, 'received.json'), 'utf8');
        await f.handler.flush();
        expect(f.reports.at(-1)?.status).toBe('completed');
        expect(await readFile(join(f.directory, 'received.json'), 'utf8')).toBe(before);
    });
    it('marks interrupted execution uncertain and does not replay it', async () => {
        const f = await fixture();
        await writeFile(join(f.directory, `local-${f.run.id}.json`), JSON.stringify({ run: f.run, report: { claimId: f.run.claimId, status: 'running', sequence: 1 } }));
        await f.handler.flush();
        await f.handler.execute(f.run, f.config);
        expect(f.reports.every(r => r.status === 'uncertain')).toBe(true);
        await expect(readFile(join(f.directory, 'received.json'))).rejects.toThrow();
    });
    it('persists acknowledgements and isolates corrupt and permanently rejected receipts', async () => {
        const f = await fixture();
        await f.handler.execute(f.run, f.config); const count = f.reports.length;
        await f.handler.flush(); await f.handler.flush(); expect(f.reports).toHaveLength(count);
        const stale = randomUUID(), broken = randomUUID(), good = randomUUID();
        await writeFile(join(f.directory, `local-${broken}.json`), '{broken');
        for (const id of [stale, good]) await writeFile(join(f.directory, `local-${id}.json`), JSON.stringify({ run: { id, taskId: f.taskId, claimId: f.run.claimId }, report: { claimId: f.run.claimId, status: 'completed', sequence: 2 } }));
        const sent: string[] = [], problems: string[] = [];
        const handler = createLocalTaskHandler(f.directory, async (run, report) => {
            sent.push(run.id); if (run.id === stale) throw { response: { status: 404 } };
            return { id: run.id, claimId: run.claimId, status: report.status };
        }, (_id, reason) => { problems.push(reason); });
        await handler.flush(); await handler.flush();
        expect(sent.sort()).toEqual([stale, good].sort());
        expect(problems).toContain('receipt-recovery-failed');
        await handler.execute({ ...f.run, id: randomUUID() }, f.config);
        expect(sent).toHaveLength(4);
    });
    it('never starts a child when a successful HTTP report returns uncertain or cancelled', async () => {
        for (const status of ['uncertain', 'cancelled'] as const) {
            const f = await fixture();
            const handler = createLocalTaskHandler(f.directory, async run => ({ id: run.id, claimId: run.claimId, status }));
            await handler.execute(f.run, f.config);
            await handler.flush();
            await expect(readFile(join(f.directory, 'received.json'))).rejects.toThrow();
        }
    });
});
