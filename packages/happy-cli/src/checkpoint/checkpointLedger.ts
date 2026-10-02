import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
    resolveCheckpointStoreLayout,
    type CheckpointStoreBinding,
} from './checkpointStore';

const ledgerIdentifierSchema = z.string().min(1).max(128).refine(
    (value) => value.trim() === value && !/[\u0000-\u001F\u007F]/.test(value),
);

const ledgerPathSchema = z.string().min(1).refine((value) => (
    !value.includes('\0')
    && !/^(?:[A-Za-z]:|[\\/])/.test(value)
    && !value.split(/[\\/]+/).includes('..')
));

const ledgerRecordSchema = z.object({
    schemaVersion: z.literal(1),
    operationId: ledgerIdentifierSchema,
    mutationId: ledgerIdentifierSchema,
    path: ledgerPathSchema,
    action: z.enum(['written', 'deleted']),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    timestamp: z.number().int().nonnegative(),
}).strict().refine((record) => (
    (record.action === 'written' && record.contentHash !== null)
    || (record.action === 'deleted' && record.contentHash === null)
));

export type CheckpointLedgerRecord = z.infer<typeof ledgerRecordSchema>;

export type CheckpointLedgerBinding = Omit<CheckpointStoreBinding, 'checkpointRoot'> & {
    projectPath: string;
};

export type CheckpointLedgerMutationRequest = CheckpointLedgerBinding & {
    operationId: string;
    mutationId: string;
    path: string;
    action: 'written' | 'deleted';
    expectedContentHash?: string | null;
};

const ledgerWriteQueues = new Map<string, Promise<void>>();

type LoadedJournal = {
    records: CheckpointLedgerRecord[];
    validBytes: number;
    hasPartialTail: boolean;
};

export class CheckpointLedger {
    private readonly checkpointRoot: string;

    constructor(checkpointRoot: string) {
        this.checkpointRoot = resolve(checkpointRoot);
    }

    recordMutation(request: CheckpointLedgerMutationRequest): Promise<CheckpointLedgerRecord> {
        const ledgerFile = resolveCheckpointStoreLayout({
            checkpointRoot: this.checkpointRoot,
            sessionId: request.sessionId,
            projectId: request.projectId,
            worktreeId: request.worktreeId,
        }).ledgerFile;
        const pending = ledgerWriteQueues.get(ledgerFile) ?? Promise.resolve();
        const result = pending.then(() => this.recordMutationNow(request));
        const next = result.then(() => undefined, () => undefined);
        ledgerWriteQueues.set(ledgerFile, next);
        void next.then(() => {
            if (ledgerWriteQueues.get(ledgerFile) === next) ledgerWriteQueues.delete(ledgerFile);
        });
        return result;
    }

    async readRecords(binding: CheckpointLedgerBinding): Promise<CheckpointLedgerRecord[]> {
        const { layout } = await this.resolveBoundLayout(binding);
        return (await loadJournal(layout.ledgerFile)).records;
    }

    private async recordMutationNow(
        request: CheckpointLedgerMutationRequest,
    ): Promise<CheckpointLedgerRecord> {
        const { layout, projectPath } = await this.resolveBoundLayout(request);
        const path = normalizeLedgerPath(request.path, projectPath);
        const journal = await loadJournal(layout.ledgerFile);
        const existing = journal.records.find((record) => (
            record.operationId === request.operationId
            && record.mutationId === request.mutationId
        ));
        if (existing) {
            if (existing.path !== path || existing.action !== request.action) {
                throw new Error('checkpoint ledger idempotency key conflict');
            }
            return existing;
        }

        const contentHash = request.action === 'written'
            ? await hashRegularFile(resolve(projectPath, path))
            : await assertFileDeleted(resolve(projectPath, path));
        if (request.expectedContentHash !== undefined && contentHash !== request.expectedContentHash) {
            throw new Error('checkpoint ledger mutation changed before recording');
        }
        const record = ledgerRecordSchema.parse({
            schemaVersion: 1,
            operationId: request.operationId,
            mutationId: request.mutationId,
            path,
            action: request.action,
            contentHash,
            timestamp: Date.now(),
        });

        await mkdir(dirname(layout.ledgerFile), { recursive: true });
        if (journal.hasPartialTail) {
            const journalHandle = await open(layout.ledgerFile, 'r+');
            try {
                await journalHandle.truncate(journal.validBytes);
                await journalHandle.sync();
            } finally {
                await journalHandle.close();
            }
        }
        const ledgerHandle = await open(layout.ledgerFile, 'a', 0o600);
        try {
            await ledgerHandle.chmod(0o600);
            await ledgerHandle.writeFile(`${JSON.stringify(record)}\n`);
            await ledgerHandle.sync();
        } finally {
            await ledgerHandle.close();
        }
        return record;
    }

    private async resolveBoundLayout(binding: CheckpointLedgerBinding) {
        const layout = resolveCheckpointStoreLayout({
            checkpointRoot: this.checkpointRoot,
            sessionId: binding.sessionId,
            projectId: binding.projectId,
            worktreeId: binding.worktreeId,
        });
        const projectPath = await realpath(binding.projectPath);
        let metadata: Record<string, unknown>;
        try {
            metadata = JSON.parse(await readFile(layout.metadataFile, 'utf8')) as Record<string, unknown>;
        } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
                throw new Error('checkpoint binding is required before ledger writes');
            }
            throw error;
        }
        if (
            metadata.projectPath !== projectPath
            || metadata.sessionId !== binding.sessionId
            || metadata.projectId !== binding.projectId
            || metadata.worktreeId !== binding.worktreeId
        ) {
            throw new Error('checkpoint ledger binding mismatch');
        }
        return { layout, projectPath };
    }
}

function normalizeLedgerPath(path: string, projectPath: string): string {
    if (
        path.length === 0
        || path.includes('\0')
        || isAbsolute(path)
        || /^(?:[A-Za-z]:|[\\/])/.test(path)
        || path.split(/[\\/]+/).includes('..')
    ) {
        throw new Error('checkpoint ledger path must be project-relative');
    }
    const absolutePath = resolve(projectPath, path);
    const normalizedPath = relative(projectPath, absolutePath);
    if (normalizedPath === '' || normalizedPath.startsWith(`..${sep}`) || isAbsolute(normalizedPath)) {
        throw new Error('checkpoint ledger path must be project-relative');
    }
    return normalizedPath.split(sep).join('/');
}

async function hashRegularFile(path: string): Promise<string> {
    const fileStats = await lstat(path);
    if (!fileStats.isFile()) {
        throw new Error('checkpoint ledger can only hash regular files');
    }
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) {
        hash.update(chunk);
    }
    return hash.digest('hex');
}

async function assertFileDeleted(path: string): Promise<null> {
    try {
        await lstat(path);
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
        throw error;
    }
    throw new Error('checkpoint ledger delete record requires a missing path');
}

async function loadJournal(path: string): Promise<LoadedJournal> {
    let contents: Buffer;
    try {
        contents = await readFile(path);
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            return { records: [], validBytes: 0, hasPartialTail: false };
        }
        throw error;
    }
    const finalNewline = contents.lastIndexOf(0x0a);
    const validBytes = finalNewline + 1;
    const complete = contents.subarray(0, validBytes).toString('utf8');
    const records = complete.length === 0
        ? []
        : complete.trimEnd().split('\n').map((line) => {
            try {
                return ledgerRecordSchema.parse(JSON.parse(line));
            } catch {
                throw new Error('checkpoint ledger contains a corrupt record');
            }
        });
    const seen = new Map<string, CheckpointLedgerRecord>();
    for (const record of records) {
        const key = JSON.stringify([record.operationId, record.mutationId]);
        const prior = seen.get(key);
        if (prior && JSON.stringify(prior) !== JSON.stringify(record)) {
            throw new Error('checkpoint ledger idempotency key conflict');
        }
        seen.set(key, record);
    }
    return {
        records: [...seen.values()],
        validBytes,
        hasPartialTail: validBytes !== contents.length,
    };
}
