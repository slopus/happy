/**
 * Import Journal
 *
 * Records which Claude Code sessions (from ~/.claude/projects/<dir>/<uuid>.jsonl)
 * have been imported into Happy and stores the encryption material captured at
 * import time. This is the trust anchor that lets the daemon adopt and resume
 * sessions it didn't originally spawn — without needing a separate happy-agent
 * key for decryption.
 *
 * File: ~/.happy/imported-sessions.json
 *
 * Concurrency: uses an exclusive lock file (same pattern as updateSettings in
 * persistence.ts) so concurrent `happy import` invocations don't trample each
 * other.
 */

import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';

import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';

export const IMPORT_JOURNAL_SCHEMA_VERSION = 1;

/**
 * Single imported-session entry.
 *
 * Keyed in the journal by `claudeSessionId` — the UUID of the *leaf* JSONL
 * file (the one with no descendants in the summary/leafUuid chain).
 *
 * When the user runs `claude --resume <claudeSessionId>` natively, Claude
 * creates a *new* JSONL with a new UUID and prefixes the old history. A
 * subsequent `happy import` will detect this new leaf and update the entry's
 * `claudeSessionId` (the happy-session id stays the same — only the SDK side
 * has a new identity, captured in metadata.claudeSessionId via the next
 * SessionStart hook fire).
 */
export const ImportedSessionEntrySchema = z.object({
    claudeSessionId: z.string(),
    happySessionId: z.string(),
    cwd: z.string(),
    jsonlPath: z.string(),
    importedAt: z.number(),
    encryptionKey: z.string(), // base64
    encryptionVariant: z.union([z.literal('legacy'), z.literal('dataKey')]),
    backfillStatus: z.union([
        z.literal('complete'),
        z.literal('partial'),
        z.literal('failed'),
        z.literal('skipped'),
    ]),
    /** Line count successfully sent to the server (0 if --no-backfill). */
    backfilledLineCount: z.number().int().nonnegative(),
    /** Total lines in the JSONL at last import; used to detect appended tails. */
    jsonlLineCount: z.number().int().nonnegative().optional(),
    /** Mtime of JSONL at last import; used to detect changes since import. */
    jsonlMtimeMs: z.number().optional(),
    jsonlSizeBytes: z.number().int().nonnegative().optional(),
});

export type ImportedSessionEntry = z.infer<typeof ImportedSessionEntrySchema>;

const ImportJournalFileSchema = z.object({
    version: z.literal(IMPORT_JOURNAL_SCHEMA_VERSION),
    imported: z.record(z.string(), ImportedSessionEntrySchema),
});

type ImportJournalFile = z.infer<typeof ImportJournalFileSchema>;

const EMPTY_JOURNAL: ImportJournalFile = {
    version: IMPORT_JOURNAL_SCHEMA_VERSION,
    imported: {},
};

function journalFilePath(): string {
    return join(configuration.happyHomeDir, 'imported-sessions.json');
}

function lockFilePath(): string {
    return journalFilePath() + '.lock';
}

function tmpFilePath(): string {
    return journalFilePath() + '.tmp';
}

export async function readImportJournal(): Promise<ImportJournalFile> {
    const path = journalFilePath();
    if (!existsSync(path)) {
        return { ...EMPTY_JOURNAL, imported: {} };
    }
    try {
        const content = await readFile(path, 'utf8');
        const raw = JSON.parse(content);
        const parsed = ImportJournalFileSchema.safeParse(raw);
        if (!parsed.success) {
            const backup = `${path}.corrupted-${Date.now()}.json`;
            await rename(path, backup);
            logger.warn(`Import journal at ${path} was corrupted; backed up to ${backup}`);
            return { ...EMPTY_JOURNAL, imported: {} };
        }
        return parsed.data;
    } catch (error: any) {
        logger.warn(`Failed to read import journal: ${error?.message ?? error}`);
        return { ...EMPTY_JOURNAL, imported: {} };
    }
}

/**
 * Atomically update the journal under an exclusive lock.
 *
 * Same retry / stale-lock semantics as updateSettings in persistence.ts.
 */
export async function updateImportJournal(
    updater: (current: ImportJournalFile) => ImportJournalFile | Promise<ImportJournalFile>,
): Promise<ImportJournalFile> {
    const LOCK_RETRY_INTERVAL_MS = 100;
    const MAX_LOCK_ATTEMPTS = 50;
    const STALE_LOCK_TIMEOUT_MS = 10_000;

    const lockFile = lockFilePath();
    const tmpFile = tmpFilePath();
    let fileHandle;
    let attempts = 0;

    while (attempts < MAX_LOCK_ATTEMPTS) {
        try {
            fileHandle = await open(lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
            break;
        } catch (err: any) {
            if (err.code === 'EEXIST') {
                attempts++;
                await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_INTERVAL_MS));
                try {
                    const stats = await stat(lockFile);
                    if (Date.now() - stats.mtimeMs > STALE_LOCK_TIMEOUT_MS) {
                        await unlink(lockFile).catch(() => { });
                    }
                } catch { /* ignore */ }
            } else {
                throw err;
            }
        }
    }

    if (!fileHandle) {
        throw new Error(
            `Failed to acquire import journal lock after ${MAX_LOCK_ATTEMPTS * LOCK_RETRY_INTERVAL_MS / 1000} seconds`,
        );
    }

    try {
        const current = await readImportJournal();
        const updated = await updater(current);
        if (!existsSync(configuration.happyHomeDir)) {
            await mkdir(configuration.happyHomeDir, { recursive: true });
        }
        await writeFile(tmpFile, JSON.stringify(updated, null, 2));
        await rename(tmpFile, journalFilePath());
        return updated;
    } finally {
        await fileHandle.close();
        await unlink(lockFile).catch(() => { });
    }
}

/**
 * Find an entry by happy session ID. O(n) but n is small (one per imported
 * Claude session). Returns null if not found.
 */
export async function findEntryByHappySessionId(
    happySessionId: string,
): Promise<ImportedSessionEntry | null> {
    const journal = await readImportJournal();
    for (const entry of Object.values(journal.imported)) {
        if (entry.happySessionId === happySessionId) return entry;
    }
    return null;
}

/**
 * Find an entry by Claude session ID. O(1).
 */
export async function findEntryByClaudeSessionId(
    claudeSessionId: string,
): Promise<ImportedSessionEntry | null> {
    const journal = await readImportJournal();
    return journal.imported[claudeSessionId] ?? null;
}

/**
 * Upsert a journal entry keyed by claudeSessionId. Pass-through to
 * updateImportJournal — kept as a convenience for the common case.
 */
export async function upsertEntry(entry: ImportedSessionEntry): Promise<void> {
    await updateImportJournal(current => ({
        ...current,
        imported: {
            ...current.imported,
            [entry.claudeSessionId]: entry,
        },
    }));
}
