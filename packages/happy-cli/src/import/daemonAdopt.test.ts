import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import os from 'node:os';

// Mock configuration & logger so the journal writes to a temp dir.
const tempRootRef = { current: '' };
vi.mock('@/configuration', () => ({
    configuration: {
        get happyHomeDir() {
            return tempRootRef.current;
        },
    },
}));
vi.mock('@/ui/logger', () => ({
    logger: {
        debug: () => { },
        warn: () => { },
        info: () => { },
        error: () => { },
    },
}));

import { adoptSessionFromImportJournal } from './daemonAdopt';
import { upsertEntry } from './importJournal';

describe('adoptSessionFromImportJournal', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = join(tmpdir(), `adopt-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(tempDir, { recursive: true });
        tempRootRef.current = tempDir;
    });

    afterEach(() => {
        if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
    });

    it('returns null when session is not in the journal', async () => {
        const result = await adoptSessionFromImportJournal('cuid-never-seen');
        expect(result).toBeNull();
    });

    it('builds a TrackedSession from a journal entry', async () => {
        const claudeSessionId = '11111111-1111-1111-1111-111111111111';
        const happySessionId = 'cuid-abc-123';
        await upsertEntry({
            claudeSessionId,
            happySessionId,
            cwd: '/Users/me/proj',
            jsonlPath: '/x.jsonl',
            importedAt: Date.now(),
            // 32 random bytes encoded base64
            encryptionKey: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
            encryptionVariant: 'dataKey',
            backfillStatus: 'complete',
            backfilledLineCount: 5,
        });

        const tracked = await adoptSessionFromImportJournal(happySessionId);
        expect(tracked).not.toBeNull();
        expect(tracked!.happySessionId).toBe(happySessionId);
        expect(tracked!.startedBy).toBe('adopted-from-import');
        expect(tracked!.pid).toBe(0);

        // Metadata has the fields buildResumeLaunch needs
        const meta = tracked!.happySessionMetadataFromLocalWebhook!;
        expect(meta.path).toBe('/Users/me/proj');
        expect(meta.claudeSessionId).toBe(claudeSessionId);
        expect(meta.flavor).toBe('claude');
        expect(meta.host).toBe(os.hostname());

        // Encryption captures from the journal
        expect(tracked!.encryption!.encryptionVariant).toBe('dataKey');
        expect(tracked!.encryption!.encryptionKey.length).toBe(32);
        expect(tracked!.encryption!.seq).toBe(0);
        expect(tracked!.encryption!.metadataVersion).toBe(0);
        expect(tracked!.encryption!.agentStateVersion).toBe(0);
    });

    it('preserves legacy variant in adopted session', async () => {
        await upsertEntry({
            claudeSessionId: '22222222-2222-2222-2222-222222222222',
            happySessionId: 'cuid-legacy',
            cwd: '/x',
            jsonlPath: '/x.jsonl',
            importedAt: 0,
            encryptionKey: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
            encryptionVariant: 'legacy',
            backfillStatus: 'complete',
            backfilledLineCount: 0,
        });
        const tracked = await adoptSessionFromImportJournal('cuid-legacy');
        expect(tracked!.encryption!.encryptionVariant).toBe('legacy');
    });
});
