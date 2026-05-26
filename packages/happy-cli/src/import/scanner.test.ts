import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock configuration & logger so the test owns happyHomeDir + CLAUDE_CONFIG_DIR.
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

import { scanForImportCandidates } from './scanner';
import { upsertEntry } from './importJournal';

function makeProject(claudeDir: string, projectName: string, sessions: Array<{
    sessionId: string;
    summary?: { summary: string; leafUuid: string };
    cwd?: string;
    firstUserText?: string;
    mtime?: Date;
}>) {
    const dir = join(claudeDir, 'projects', projectName);
    mkdirSync(dir, { recursive: true });
    for (const session of sessions) {
        const lines: string[] = [];
        if (session.summary) {
            lines.push(JSON.stringify({ type: 'summary', summary: session.summary.summary, leafUuid: session.summary.leafUuid }));
        }
        if (session.cwd) {
            lines.push(JSON.stringify({
                type: 'user',
                uuid: 'u1',
                cwd: session.cwd,
                sessionId: session.sessionId,
                message: { role: 'user', content: session.firstUserText ?? 'hello' },
            }));
        }
        const file = join(dir, `${session.sessionId}.jsonl`);
        writeFileSync(file, lines.join('\n') + '\n');
        if (session.mtime) {
            utimesSync(file, session.mtime, session.mtime);
        }
    }
}

describe('scanForImportCandidates', () => {
    let tempDir: string;
    let claudeDir: string;
    const oldClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

    beforeEach(() => {
        tempDir = join(tmpdir(), `scanner-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        claudeDir = join(tempDir, '.claude');
        mkdirSync(claudeDir, { recursive: true });
        tempRootRef.current = join(tempDir, '.happy');
        mkdirSync(tempRootRef.current, { recursive: true });
        process.env.CLAUDE_CONFIG_DIR = claudeDir;
    });

    afterEach(() => {
        if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
        if (oldClaudeConfigDir !== undefined) {
            process.env.CLAUDE_CONFIG_DIR = oldClaudeConfigDir;
        } else {
            delete process.env.CLAUDE_CONFIG_DIR;
        }
    });

    it('returns empty list when ~/.claude/projects does not exist', async () => {
        rmSync(claudeDir, { recursive: true, force: true });
        const candidates = await scanForImportCandidates();
        expect(candidates).toEqual([]);
    });

    it('skips files with non-UUID names (agent-* etc.)', async () => {
        makeProject(claudeDir, '-Users-me-proj', [
            { sessionId: 'agent-xyz', cwd: '/Users/me/proj' },
            { sessionId: '11111111-1111-1111-1111-111111111111', cwd: '/Users/me/proj' },
        ]);
        const candidates = await scanForImportCandidates();
        expect(candidates).toHaveLength(1);
        expect(candidates[0].claudeSessionId).toBe('11111111-1111-1111-1111-111111111111');
    });

    it('drops ancestors when a resume leaf points to them', async () => {
        // Three-link chain: A (root) ← B (resume of A) ← C (resume of B)
        // Only C should remain as an import candidate.
        const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
        const B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
        const C = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
        makeProject(claudeDir, '-Users-me-proj', [
            { sessionId: A, cwd: '/Users/me/proj' },
            { sessionId: B, cwd: '/Users/me/proj', summary: { summary: 'resume of A', leafUuid: A } },
            { sessionId: C, cwd: '/Users/me/proj', summary: { summary: 'resume of B', leafUuid: B } },
        ]);
        const candidates = await scanForImportCandidates();
        expect(candidates.map(c => c.claudeSessionId).sort()).toEqual([C]);
    });

    it('excludes sessions already in the journal', async () => {
        const id = '11111111-1111-1111-1111-111111111111';
        makeProject(claudeDir, '-Users-me-proj', [
            { sessionId: id, cwd: '/Users/me/proj' },
        ]);
        // Pre-seed journal as if this session was already imported
        await upsertEntry({
            claudeSessionId: id,
            happySessionId: 'h-1',
            cwd: '/Users/me/proj',
            jsonlPath: 'irrelevant',
            importedAt: Date.now(),
            encryptionKey: 'AAA=',
            encryptionVariant: 'legacy',
            backfillStatus: 'complete',
            backfilledLineCount: 1,
        });
        const candidates = await scanForImportCandidates();
        expect(candidates).toEqual([]);
    });

    it('includes already-imported when includeAlreadyImported=true', async () => {
        const id = '11111111-1111-1111-1111-111111111111';
        makeProject(claudeDir, '-Users-me-proj', [
            { sessionId: id, cwd: '/Users/me/proj' },
        ]);
        await upsertEntry({
            claudeSessionId: id,
            happySessionId: 'h-1',
            cwd: '/Users/me/proj',
            jsonlPath: 'irrelevant',
            importedAt: Date.now(),
            encryptionKey: 'AAA=',
            encryptionVariant: 'legacy',
            backfillStatus: 'complete',
            backfilledLineCount: 1,
        });
        const candidates = await scanForImportCandidates({ includeAlreadyImported: true });
        expect(candidates).toHaveLength(1);
    });

    it('filters by projectFilter prefix', async () => {
        makeProject(claudeDir, '-Users-me-projA', [
            { sessionId: '11111111-1111-1111-1111-111111111111', cwd: '/Users/me/projA' },
        ]);
        makeProject(claudeDir, '-Users-me-projB', [
            { sessionId: '22222222-2222-2222-2222-222222222222', cwd: '/Users/me/projB' },
        ]);
        const candidates = await scanForImportCandidates({ projectFilter: '/Users/me/projA' });
        expect(candidates).toHaveLength(1);
        expect(candidates[0].claudeSessionId).toBe('11111111-1111-1111-1111-111111111111');
    });

    it('sorts candidates by mtime desc', async () => {
        const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
        const B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
        makeProject(claudeDir, '-Users-me-proj', [
            { sessionId: A, cwd: '/Users/me/proj', mtime: new Date('2025-01-01') },
            { sessionId: B, cwd: '/Users/me/proj', mtime: new Date('2025-12-31') },
        ]);
        const candidates = await scanForImportCandidates();
        expect(candidates.map(c => c.claudeSessionId)).toEqual([B, A]);
    });

    it('excludes sessions that happy already tracks via happyTrackedClaudeIds option', async () => {
        const happySpawned = '11111111-1111-1111-1111-111111111111';
        const native = '22222222-2222-2222-2222-222222222222';
        makeProject(claudeDir, '-Users-me-proj', [
            { sessionId: happySpawned, cwd: '/Users/me/proj' },
            { sessionId: native, cwd: '/Users/me/proj' },
        ]);
        const candidates = await scanForImportCandidates({
            happyTrackedClaudeIds: new Set([happySpawned]),
        });
        expect(candidates.map(c => c.claudeSessionId)).toEqual([native]);
    });

    it('includeAlreadyImported also bypasses the happy-tracked dedup', async () => {
        const happySpawned = '11111111-1111-1111-1111-111111111111';
        makeProject(claudeDir, '-Users-me-proj', [
            { sessionId: happySpawned, cwd: '/Users/me/proj' },
        ]);
        const candidates = await scanForImportCandidates({
            includeAlreadyImported: true,
            happyTrackedClaudeIds: new Set([happySpawned]),
        });
        expect(candidates).toHaveLength(1);
    });
});
