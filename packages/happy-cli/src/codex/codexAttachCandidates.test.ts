import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    createCodexAttachCandidateService,
    listCodexThreadsFromStateDb,
    readCodexThreadOriginator,
} from './codexAttachCandidates';
import type { ListedThread } from './codexAppServerTypes';

describe('Codex attach candidates', () => {
    it('keeps only meaningful, recent Codex Desktop root threads', async () => {
        const stateDir = await mkdtemp(join(tmpdir(), 'paws-codex-candidates-'));
        const service = createCodexAttachCandidateService({
            statePath: join(stateDir, 'state.json'),
            now: () => 2_000_000_000_000,
            listThreads: async () => ({
                data: [
                    thread({
                        id: 'desktop',
                        name: null,
                        preview: '<!-- happy:system-prompt:start -->hidden<!-- happy:system-prompt:end -->\nFix the inbox',
                    }),
                    thread({ id: 'empty', name: null, preview: '   ' }),
                    thread({ id: 'subagent', parentThreadId: 'desktop' }),
                    thread({ id: 'paws', source: 'vscode' }),
                    thread({ id: 'archived', archived: true }),
                ],
                nextCursor: null,
            }),
            readThreadOriginator: async (path) => path.includes('paws') ? 'happy-codex' : 'Codex Desktop',
        });

        await expect(service.list({ existingThreadIds: [] })).resolves.toEqual([
            expect.objectContaining({
                threadId: 'desktop',
                title: 'Fix the inbox',
                directory: '/Users/test/project',
            }),
        ]);
    });

    it('returns every eligible thread from the last 30 days instead of truncating at 20', async () => {
        const stateDir = await mkdtemp(join(tmpdir(), 'paws-codex-candidates-'));
        const service = createCodexAttachCandidateService({
            statePath: join(stateDir, 'state.json'),
            now: () => 2_000_000_000_000,
            listThreads: async () => ({
                data: Array.from({ length: 21 }, (_, index) => thread({
                    id: `desktop-${index + 1}`,
                    recencyAt: 1_999_999_950 - index,
                })),
                nextCursor: null,
            }),
            readThreadOriginator: async () => 'Codex Desktop',
        });

        const candidates = await service.list({ existingThreadIds: [] });

        expect(candidates).toHaveLength(21);
        expect(candidates.at(-1)?.threadId).toBe('desktop-21');
    });

    it('reads the Desktop originator from the first rollout record', async () => {
        const stateDir = await mkdtemp(join(tmpdir(), 'paws-codex-candidates-'));
        const rolloutPath = join(stateDir, 'rollout.jsonl');
        await writeFile(rolloutPath, [
            JSON.stringify({ type: 'session_meta', payload: { originator: 'Codex Desktop' } }),
            JSON.stringify({ type: 'response_item', payload: { type: 'message' } }),
        ].join('\n'));

        await expect(readCodexThreadOriginator(rolloutPath)).resolves.toBe('Codex Desktop');
    });

    it('discovers thread metadata from the read-only Codex state index', () => {
        let openedPath = '';
        let closed = false;
        const response = listCodexThreadsFromStateDb({
            codexHome: '/tmp/codex-home',
            now: () => 2_000_000_000_000,
            limit: 7,
            openDatabase: (path) => {
                openedPath = path;
                return {
                    prepare: () => ({
                        all: (oldestAllowed, limit) => {
                            expect(oldestAllowed).toBe(1_997_408_000);
                            expect(limit).toBe(7);
                            return [{
                                id: 'desktop',
                                rolloutPath: '/tmp/desktop.jsonl',
                                cwd: '/Users/test/project',
                                name: null,
                                title: 'Desktop title',
                                preview: 'First user message',
                                createdAt: 1_999_999_900,
                                updatedAt: 1_999_999_950,
                                recencyAt: 1_999_999_960,
                                source: 'vscode',
                                archived: 0,
                                parentThreadId: null,
                            }];
                        },
                    }),
                    close: () => { closed = true; },
                };
            },
        });

        expect(openedPath).toBe('/tmp/codex-home/state_5.sqlite');
        expect(closed).toBe(true);
        expect(response.data).toEqual([
            expect.objectContaining({
                id: 'desktop',
                path: '/tmp/desktop.jsonl',
                name: 'Desktop title',
                source: 'vscode',
            }),
        ]);
    });

    it('reads every matching indexed thread when no limit is requested', () => {
        const recentRows = Array.from({ length: 101 }, (_, index) => ({
            id: `desktop-${index + 1}`,
            rolloutPath: `/tmp/desktop-${index + 1}.jsonl`,
            cwd: '/Users/test/project',
            name: `Desktop ${index + 1}`,
            title: null,
            preview: 'First user message',
            createdAt: 1_999_999_900,
            updatedAt: 1_999_999_950,
            recencyAt: 1_999_999_960 - index,
            source: 'vscode',
            archived: 0,
            parentThreadId: null,
        }));
        const rows = [
            ...recentRows,
            {
                ...recentRows[0],
                id: 'desktop-too-old',
                rolloutPath: '/tmp/desktop-too-old.jsonl',
                recencyAt: 1_997_407_999,
            },
        ];

        const response = listCodexThreadsFromStateDb({
            codexHome: '/tmp/codex-home',
            now: () => 2_000_000_000_000,
            openDatabase: () => ({
                prepare: () => ({
                    all: (oldestAllowed, limit) => {
                        const eligible = typeof oldestAllowed === 'number'
                            ? rows.filter((row) => row.recencyAt >= oldestAllowed)
                            : rows;
                        return typeof limit === 'number' ? eligible.slice(0, limit) : eligible;
                    },
                }),
                close: () => undefined,
            }),
        });

        expect(response.data).toHaveLength(101);
        expect(response.data.at(-1)?.id).toBe('desktop-101');
    });

    it('persists dismissed and attached threads and also removes server-known mappings', async () => {
        const stateDir = await mkdtemp(join(tmpdir(), 'paws-codex-candidates-'));
        const statePath = join(stateDir, 'state.json');
        const listThreads = async () => ({
            data: [thread({ id: 'dismissed' }), thread({ id: 'attached' }), thread({ id: 'mapped' })],
            nextCursor: null,
        });
        const readThreadOriginator = async () => 'Codex Desktop';
        const service = createCodexAttachCandidateService({ statePath, listThreads, readThreadOriginator });

        await Promise.all([
            service.dismiss('dismissed'),
            service.markAttached('attached'),
        ]);

        const restarted = createCodexAttachCandidateService({ statePath, listThreads, readThreadOriginator });
        await expect(restarted.list({ existingThreadIds: ['mapped'] })).resolves.toEqual([]);
    });
});

function thread(overrides: Partial<ListedThread>): ListedThread {
    const id = overrides.id ?? 'thread';
    return {
        id: 'thread',
        sessionId: 'session',
        forkedFromId: null,
        parentThreadId: null,
        preview: 'First user message',
        ephemeral: false,
        modelProvider: 'openai',
        createdAt: 1_999_999_900,
        updatedAt: 1_999_999_950,
        recencyAt: 1_999_999_950,
        status: { type: 'notLoaded' },
        path: `/tmp/${id}.jsonl`,
        cwd: '/Users/test/project',
        cliVersion: '0.149.0',
        source: 'vscode',
        threadSource: null,
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns: [],
        archived: false,
        ...overrides,
    };
}
