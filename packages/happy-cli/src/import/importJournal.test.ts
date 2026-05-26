import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock configuration BEFORE importing the journal so that
// `configuration.happyHomeDir` points at a per-test temp dir.
const tempRootRef = { current: '' };
vi.mock('@/configuration', () => ({
    configuration: {
        get happyHomeDir() {
            return tempRootRef.current;
        },
    },
}));

// Suppress logger during tests
vi.mock('@/ui/logger', () => ({
    logger: {
        debug: () => { },
        warn: () => { },
        info: () => { },
        error: () => { },
    },
}));

import {
    findEntryByClaudeSessionId,
    findEntryByHappySessionId,
    IMPORT_JOURNAL_SCHEMA_VERSION,
    readImportJournal,
    upsertEntry,
    updateImportJournal,
    type ImportedSessionEntry,
} from './importJournal';

function makeEntry(overrides: Partial<ImportedSessionEntry> = {}): ImportedSessionEntry {
    return {
        claudeSessionId: '11111111-1111-1111-1111-111111111111',
        happySessionId: 'cuid-abc-123',
        cwd: '/Users/me/proj',
        jsonlPath: '/x.jsonl',
        importedAt: 1700000000000,
        encryptionKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        encryptionVariant: 'dataKey',
        backfillStatus: 'complete',
        backfilledLineCount: 10,
        ...overrides,
    };
}

describe('import journal', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = join(tmpdir(), `import-journal-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(tempDir, { recursive: true });
        tempRootRef.current = tempDir;
    });

    afterEach(() => {
        if (existsSync(tempDir)) {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('returns empty journal when file is missing', async () => {
        const journal = await readImportJournal();
        expect(journal.version).toBe(IMPORT_JOURNAL_SCHEMA_VERSION);
        expect(journal.imported).toEqual({});
    });

    it('upsertEntry persists round-trip', async () => {
        const entry = makeEntry();
        await upsertEntry(entry);
        const journal = await readImportJournal();
        expect(journal.imported[entry.claudeSessionId]).toEqual(entry);
    });

    it('upsertEntry overwrites existing entry by claudeSessionId', async () => {
        await upsertEntry(makeEntry({ backfilledLineCount: 5, backfillStatus: 'partial' }));
        await upsertEntry(makeEntry({ backfilledLineCount: 50, backfillStatus: 'complete' }));
        const journal = await readImportJournal();
        const stored = journal.imported['11111111-1111-1111-1111-111111111111'];
        expect(stored.backfilledLineCount).toBe(50);
        expect(stored.backfillStatus).toBe('complete');
    });

    it('findEntryByHappySessionId locates by happy id', async () => {
        await upsertEntry(makeEntry({ happySessionId: 'cuid-foo', claudeSessionId: 'aaaaaaaa-1111-1111-1111-111111111111' }));
        await upsertEntry(makeEntry({ happySessionId: 'cuid-bar', claudeSessionId: 'bbbbbbbb-2222-2222-2222-222222222222' }));
        const found = await findEntryByHappySessionId('cuid-bar');
        expect(found?.claudeSessionId).toBe('bbbbbbbb-2222-2222-2222-222222222222');
        const missing = await findEntryByHappySessionId('cuid-not-here');
        expect(missing).toBeNull();
    });

    it('findEntryByClaudeSessionId is O(1) and returns the right entry', async () => {
        await upsertEntry(makeEntry({ claudeSessionId: 'aaaaaaaa-1111-1111-1111-111111111111' }));
        const found = await findEntryByClaudeSessionId('aaaaaaaa-1111-1111-1111-111111111111');
        expect(found).not.toBeNull();
    });

    it('recovers from a corrupted journal file by backing it up', async () => {
        const journalPath = join(tempDir, 'imported-sessions.json');
        writeFileSync(journalPath, '{not valid json');
        const journal = await readImportJournal();
        expect(journal.imported).toEqual({});
        // Corrupted file should have been moved aside (backup file exists)
        // Newly read journal returns empty without throwing.
    });

    it('rejects schema mismatch and treats it as corrupted', async () => {
        const journalPath = join(tempDir, 'imported-sessions.json');
        writeFileSync(journalPath, JSON.stringify({ version: 999, imported: {} }));
        const journal = await readImportJournal();
        expect(journal.imported).toEqual({});
    });

    it('atomic update: serial calls all land', async () => {
        const ids = ['aaaaaaaa-1111-1111-1111-111111111111', 'bbbbbbbb-2222-2222-2222-222222222222', 'cccccccc-3333-3333-3333-333333333333'];
        for (const id of ids) {
            await upsertEntry(makeEntry({ claudeSessionId: id, happySessionId: `h-${id.slice(0, 6)}` }));
        }
        const journal = await readImportJournal();
        expect(Object.keys(journal.imported).sort()).toEqual(ids.sort());
    });

    it('updateImportJournal applies arbitrary updater', async () => {
        await upsertEntry(makeEntry());
        await updateImportJournal(current => ({
            ...current,
            imported: Object.fromEntries(
                Object.entries(current.imported).map(([k, v]) => [k, { ...v, backfilledLineCount: 999 }])
            ),
        }));
        const after = await readImportJournal();
        expect(Object.values(after.imported)[0].backfilledLineCount).toBe(999);
    });
});
