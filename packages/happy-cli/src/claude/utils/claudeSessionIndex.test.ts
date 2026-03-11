import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('listClaudeSessionsFromIndex', () => {
    let tempRoot: string;
    let claudeConfigDir: string;
    let happyHomeDir: string;
    let oldClaudeConfigDir: string | undefined;
    let oldHappyHomeDir: string | undefined;

    beforeEach(() => {
        tempRoot = mkdtempSync(join(tmpdir(), 'claude-session-index-'));
        claudeConfigDir = join(tempRoot, 'claude');
        happyHomeDir = join(tempRoot, 'happy-home');

        mkdirSync(join(claudeConfigDir, 'projects'), { recursive: true });
        mkdirSync(happyHomeDir, { recursive: true });

        oldClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
        oldHappyHomeDir = process.env.HAPPY_HOME_DIR;

        process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
        process.env.HAPPY_HOME_DIR = happyHomeDir;
    });

    afterEach(() => {
        if (oldClaudeConfigDir === undefined) {
            delete process.env.CLAUDE_CONFIG_DIR;
        } else {
            process.env.CLAUDE_CONFIG_DIR = oldClaudeConfigDir;
        }

        if (oldHappyHomeDir === undefined) {
            delete process.env.HAPPY_HOME_DIR;
        } else {
            process.env.HAPPY_HOME_DIR = oldHappyHomeDir;
        }

        vi.restoreAllMocks();
        vi.resetModules();
        if (tempRoot && existsSync(tempRoot)) {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('uses summary records from JSONL when sessions-index title is missing', async () => {
        const projectId = 'project-summary';
        const projectDir = join(claudeConfigDir, 'projects', projectId);
        mkdirSync(projectDir, { recursive: true });

        writeFileSync(
            join(projectDir, 'sessions-index.json'),
            JSON.stringify({
                originalPath: '/repo/work',
                entries: [{ sessionId: 'session-a' }]
            })
        );

        const jsonlLines = [
            { type: 'user', uuid: 'u1', parentUuid: null, isSidechain: false, timestamp: '2026-03-10T10:00:00.000Z', message: { content: [{ type: 'text', text: 'Initial request' }] } },
            { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-03-10T10:01:00.000Z', message: { content: [{ type: 'text', text: 'Answer' }] } },
            { type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: '2026-03-10T10:02:00.000Z', message: { content: [{ type: 'text', text: 'Follow up' }] } },
            { type: 'summary', leafUuid: 'u2', summary: 'Session summary from file' }
        ];
        writeFileSync(
            join(projectDir, 'session-a.jsonl'),
            jsonlLines.map((line) => JSON.stringify(line)).join('\n') + '\n'
        );

        vi.resetModules();
        const { listClaudeSessionsFromIndex } = await import('./claudeSessionIndex');
        const sessions = await listClaudeSessionsFromIndex();

        expect(sessions).toHaveLength(1);
        expect(sessions[0].title).toBe('Session summary from file');
        expect(sessions[0].messageCount).toBe(2);

        const cachePath = join(happyHomeDir, 'claude-session-metadata-cache.json');
        expect(existsSync(cachePath)).toBe(true);
        const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
        expect(cache.lastRun.filesProcessed).toBe(1);
        expect(cache.lastRun.filesReparsed).toBe(1);
        expect(cache.lastRun.resultCount).toBe(1);
        expect(cache.lastRun.extra.indexFilesRead).toBe(1);
    });

    it('falls back to first meaningful user message when no summary exists', async () => {
        const projectId = 'project-fallback';
        const projectDir = join(claudeConfigDir, 'projects', projectId);
        mkdirSync(projectDir, { recursive: true });

        writeFileSync(
            join(projectDir, 'sessions-index.json'),
            JSON.stringify({
                originalPath: '/repo/another',
                entries: [{ sessionId: 'session-b' }]
            })
        );

        const jsonlLines = [
            {
                type: 'user',
                uuid: 'u1',
                parentUuid: null,
                isMeta: true,
                isSidechain: false,
                timestamp: '2026-03-10T09:00:00.000Z',
                message: { content: [{ type: 'text', text: 'This session is being continued with the conversation from before' }] }
            },
            { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-03-10T09:01:00.000Z', message: { content: [{ type: 'text', text: 'system info' }] } },
            {
                type: 'user',
                uuid: 'u2',
                parentUuid: 'a1',
                timestamp: '2026-03-10T09:02:00.000Z',
                message: { content: [{ type: 'text', text: '<ide_context>ignored' }] }
            },
            { type: 'assistant', uuid: 'a2', parentUuid: 'u2', timestamp: '2026-03-10T09:03:00.000Z', message: { content: [{ type: 'text', text: 'reply' }] } },
            {
                type: 'user',
                uuid: 'u3',
                parentUuid: 'a2',
                timestamp: '2026-03-10T09:04:00.000Z',
                message: { content: [{ type: 'text', text: 'Need help optimizing list loading performance for session history' }] }
            }
        ];
        writeFileSync(
            join(projectDir, 'session-b.jsonl'),
            jsonlLines.map((line) => JSON.stringify(line)).join('\n') + '\n'
        );

        vi.resetModules();
        const { listClaudeSessionsFromIndex } = await import('./claudeSessionIndex');
        const sessions = await listClaudeSessionsFromIndex();

        expect(sessions).toHaveLength(1);
        expect(sessions[0].title).toBe('Need help optimizing list loading performance for session history');
        expect(sessions[0].messageCount).toBe(3);

        const cachePath = join(happyHomeDir, 'claude-session-metadata-cache.json');
        const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
        expect(cache.entries[`${projectId}:session-b`].titleExtracted).toBe(true);
        expect(cache.lastRun.filesProcessed).toBe(1);
        expect(cache.lastRun.filesReparsed).toBe(1);
    });

    it('does not reparse unchanged file when updatedAt/gitBranch are already extracted as missing', async () => {
        const projectId = 'project-no-metadata';
        const projectDir = join(claudeConfigDir, 'projects', projectId);
        mkdirSync(projectDir, { recursive: true });

        writeFileSync(
            join(projectDir, 'sessions-index.json'),
            JSON.stringify({
                originalPath: '/repo/no-meta',
                entries: [{ sessionId: 'session-c', title: 'Indexed title', messageCount: 1 }]
            })
        );

        const jsonlLines = [
            {
                type: 'user',
                uuid: 'u1',
                parentUuid: null,
                isMeta: false,
                isSidechain: false,
                message: { content: [{ type: 'text', text: 'Hello without timestamp and branch' }] }
            },
            {
                type: 'assistant',
                uuid: 'a1',
                parentUuid: 'u1',
                message: { content: [{ type: 'text', text: 'Ack' }] }
            }
        ];
        writeFileSync(
            join(projectDir, 'session-c.jsonl'),
            jsonlLines.map((line) => JSON.stringify(line)).join('\n') + '\n'
        );

        vi.resetModules();
        const { listClaudeSessionsFromIndex } = await import('./claudeSessionIndex');
        await listClaudeSessionsFromIndex();

        const cachePath = join(happyHomeDir, 'claude-session-metadata-cache.json');
        const firstWriteMtimeMs = statSync(cachePath).mtimeMs;
        const firstCache = JSON.parse(readFileSync(cachePath, 'utf8'));
        const firstEntry = firstCache.entries[`${projectId}:session-c`];
        expect(firstEntry.updatedAtExtracted).toBe(true);
        expect(firstEntry.gitBranchExtracted).toBe(true);
        expect(firstEntry.updatedAt).toBeUndefined();
        expect(firstEntry.gitBranch).toBeNull();

        await new Promise((resolve) => setTimeout(resolve, 25));
        await listClaudeSessionsFromIndex();

        const secondWriteMtimeMs = statSync(cachePath).mtimeMs;
        expect(secondWriteMtimeMs).toBe(firstWriteMtimeMs);
    });
});
