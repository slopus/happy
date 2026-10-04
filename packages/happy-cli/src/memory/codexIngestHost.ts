/** Persist completed native Codex turns on the account host, outside the agent sandbox. */
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveServiceEntry } from './cmlLessonHost';
import { loadExternalEsModule } from './externalModuleLoader';
import { RECALL_OWNER_ENV } from './recallOwnerMarker';
import type { SandboxPolicyMode } from '@/sandbox/sandboxPolicy';

const PREPARE_BUDGET_MS = 2_000;
const INGEST_BUDGET_MS = 15_000;
const OUTPUT_LIMIT_BYTES = 16 * 1024;
const MAX_PENDING_THREADS = 16;

export type CodexIngestReason = 'imported' | 'empty' | 'unsupported' | 'cancelled' | 'timeout'
    | 'spawn_failed' | 'ingest_failed' | 'invalid_output' | 'output_limit' | 'queue_full';
export interface CodexIngestResult {
    reason: CodexIngestReason;
    importedPrompts: number;
    importedResponses: number;
    skippedDuplicates: number;
    completedTurns: number;
}
export interface CodexIngestInput {
    /** The owning provider thread, obtained from this run's app-server. */
    threadId: string;
    /** The provider's own thread.path, never a user-turn or RPC argument. */
    transcriptPath: string;
    throughTurnId: string;
}
export interface CodexIngestHost {
    ingest(input: CodexIngestInput): Promise<CodexIngestResult>;
    /** Seal admission, cancel queued work, and join any killed worker before releasing ownership. */
    close(): Promise<void>;
}

interface HostDependencies {
    resolveEntry: typeof resolveServiceEntry;
    load: typeof loadExternalEsModule;
    exists: typeof existsSync;
    spawn: (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
}
const productionDeps: HostDependencies = { resolveEntry: resolveServiceEntry, load: loadExternalEsModule, exists: existsSync, spawn };
const emptyResult = (reason: CodexIngestReason): CodexIngestResult => ({
    reason, importedPrompts: 0, importedResponses: 0, skippedDuplicates: 0, completedTurns: 0,
});
const countFields = ['importedPrompts', 'importedResponses', 'skippedDuplicates', 'completedTurns'] as const;

// Fixed code, fixed installed service, stdin-only inputs. Neither prompts nor paths are logged.
// The worker owns opening/closing SQLite; the session process only inspects capabilities.
const INGEST_WORKER = `
const { pathToFileURL } = require('node:url');
(async () => {
    let data = '', size = 0;
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
        size += Buffer.byteLength(chunk);
        if (size > 32768) throw new Error('input_limit');
        data += chunk.toString();
    }
    const input = JSON.parse(data);
    const service = await import(pathToFileURL(process.argv[1]).href);
    const capability = service.CML_CODEX_INGEST_CAPABILITIES;
    if (capability?.version !== 1 || capability.completedTurnsOnly !== true || typeof service.importCodexCompletedTurns !== 'function') {
        process.stdout.write(JSON.stringify({ version: 1, reason: 'unsupported' }));
        return;
    }
    const result = await service.importCodexCompletedTurns(input);
    const counts = {};
    for (const key of ['importedPrompts', 'importedResponses', 'skippedDuplicates', 'completedTurns']) {
        if (!Number.isSafeInteger(result?.[key]) || result[key] < 0) throw new Error('invalid_counts');
        counts[key] = result[key];
    }
    process.stdout.write(JSON.stringify({ version: 1, reason: 'complete', ...counts }));
})().catch(() => {
    process.stdout.write(JSON.stringify({ version: 1, reason: 'ingest_failed' }));
    process.exitCode = 1;
});
`;

/** Optional on older CML installs. Account/shared-machine gates are the same as host recall. */
export async function prepareCodexIngestHost(input: {
    accountOwned: boolean;
    sandboxEnabled: boolean;
    sandboxPolicyMode: SandboxPolicyMode;
    projectPath: string;
    env: NodeJS.ProcessEnv;
    report?: (result: CodexIngestResult) => void;
    // Host/test-only dependencies and bounds, never exposed through a model-facing RPC.
    deps?: Partial<HostDependencies>;
    prepareBudgetMs?: number;
    budgetMs?: number;
}): Promise<CodexIngestHost | null> {
    if (!input.accountOwned || !input.sandboxEnabled || input.sandboxPolicyMode !== 'owner-choice') return null;
    const deps = { ...productionDeps, ...input.deps };
    const projectPath = input.projectPath;
    const env: NodeJS.ProcessEnv = { ...input.env, [RECALL_OWNER_ENV]: 'host-worker' };
    delete env.CLAUDE_MEMORY_DEBUG;
    let prepareTimer: ReturnType<typeof setTimeout> | undefined;
    let entry: string | null;
    try {
        entry = await Promise.race([
            (async () => {
                const lessonEntry = await deps.resolveEntry(env);
                if (!lessonEntry) return null;
                const candidate = join(dirname(lessonEntry), 'codex-host-ingest.js');
                if (!deps.exists(candidate)) return null;
                const loaded = await deps.load(pathToFileURL(candidate).href);
                const capability = loaded.CML_CODEX_INGEST_CAPABILITIES as Record<string, unknown> | undefined;
                return capability?.version === 1 && capability.completedTurnsOnly === true
                    && typeof loaded.importCodexCompletedTurns === 'function' ? candidate : null;
            })(),
            new Promise<null>(resolve => { prepareTimer = setTimeout(() => resolve(null), input.prepareBudgetMs ?? PREPARE_BUDGET_MS); }),
        ]);
    } catch { return null; }
    finally { if (prepareTimer) clearTimeout(prepareTimer); }
    if (!entry) return null;
    const preparedEntry = entry;
    const controller = new AbortController();
    let closed = false;

    const report = (result: CodexIngestResult) => {
        try { input.report?.(result); } catch { /* Diagnostics cannot change provider success. */ }
    };
    const runWorker = (request: CodexIngestInput): Promise<CodexIngestResult> => new Promise(resolve => {
        let proc: ChildProcessWithoutNullStreams;
        let stdout = '';
        let outputBytes = 0;
        let forcedReason: CodexIngestReason | null = null;
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (result: CodexIngestResult) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            controller.signal.removeEventListener('abort', cancelled);
            report(result);
            resolve(result);
        };
        const stop = (reason: CodexIngestReason) => {
            if (settled || forcedReason) return;
            forcedReason = reason;
            if (timer) clearTimeout(timer);
            // Resolve only on close: killing is not evidence that the SQLite writer has exited.
            proc.kill('SIGKILL');
        };
        const cancelled = () => stop('cancelled');
        if (controller.signal.aborted) { finish(emptyResult('cancelled')); return; }
        try {
            proc = deps.spawn(process.execPath, ['-e', INGEST_WORKER, preparedEntry], {
                cwd: projectPath, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
            });
        } catch { finish(emptyResult('spawn_failed')); return; }
        controller.signal.addEventListener('abort', cancelled, { once: true });
        timer = setTimeout(() => stop('timeout'), input.budgetMs ?? INGEST_BUDGET_MS);
        const collect = (chunk: Buffer | string, isStdout: boolean) => {
            if (settled || forcedReason) return;
            outputBytes += Buffer.byteLength(chunk);
            if (outputBytes > OUTPUT_LIMIT_BYTES) { stop('output_limit'); return; }
            if (isStdout) stdout += chunk.toString();
            // stderr is bounded and discarded, never interpolated into a report or prompt.
        };
        proc.stdout.setEncoding('utf8').on('data', chunk => collect(chunk, true));
        proc.stderr.on('data', chunk => collect(chunk, false));
        proc.on('error', () => stop('spawn_failed'));
        proc.stdin.on('error', () => stop('spawn_failed'));
        proc.on('close', code => {
            if (forcedReason) { finish(emptyResult(forcedReason)); return; }
            if (code !== 0) { finish(emptyResult('ingest_failed')); return; }
            try {
                const record = JSON.parse(stdout);
                if (record?.version !== 1) { finish(emptyResult('invalid_output')); return; }
                if (record.reason === 'unsupported') { finish(emptyResult('unsupported')); return; }
                if (record.reason !== 'complete' || countFields.some(key => !Number.isSafeInteger(record[key]) || record[key] < 0)) {
                    finish(emptyResult('invalid_output')); return;
                }
                finish({
                    reason: record.importedPrompts + record.importedResponses > 0 ? 'imported' : 'empty',
                    importedPrompts: record.importedPrompts,
                    importedResponses: record.importedResponses,
                    skippedDuplicates: record.skippedDuplicates,
                    completedTurns: record.completedTurns,
                });
            } catch { finish(emptyResult('invalid_output')); }
        });
        try {
            proc.stdin.end(JSON.stringify({
                projectPath, transcriptPath: request.transcriptPath, sessionId: request.threadId,
                throughTurnId: request.throughTurnId,
            }));
        } catch { stop('spawn_failed'); }
        if (controller.signal.aborted) cancelled();
    });

    type Pending = { request: CodexIngestInput; resolve: Array<(result: CodexIngestResult) => void> };
    const pending = new Map<string, Pending>();
    let running: Promise<void> | null = null;
    const pump = async () => {
        while (!closed && pending.size) {
            const [key, job] = pending.entries().next().value as [string, Pending];
            pending.delete(key);
            const result = await runWorker(job.request);
            for (const resolve of job.resolve) resolve(result);
        }
    };
    const kick = () => {
        if (running || closed) return;
        running = pump().finally(() => {
            running = null;
            if (pending.size && !closed) kick();
        });
    };
    return {
        ingest(request) {
            if (closed) return Promise.resolve(emptyResult('cancelled'));
            if (!request.threadId.trim() || !request.throughTurnId.trim() || !isAbsolute(request.transcriptPath)) return Promise.resolve(emptyResult('invalid_output'));
            return new Promise(resolve => {
                const key = request.threadId;
                const queued = pending.get(key);
                if (queued) {
                    // Later completions subsume earlier ones. CML's durable event IDs make retry safe.
                    queued.request = { ...request };
                    queued.resolve.push(resolve);
                } else {
                    if (pending.size >= MAX_PENDING_THREADS) { resolve(emptyResult('queue_full')); return; }
                    pending.set(key, { request: { ...request }, resolve: [resolve] });
                }
                kick();
            });
        },
        async close() {
            closed = true;
            controller.abort();
            for (const job of pending.values()) for (const resolve of job.resolve) resolve(emptyResult('cancelled'));
            pending.clear();
            await running;
        },
    };
}
