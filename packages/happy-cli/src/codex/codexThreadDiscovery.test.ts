import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { discoverCodexThreadId } from './codexThreadDiscovery';

async function writeSessionMeta(
    codexHomeDir: string,
    opts: {
        id: string;
        cwd: string;
        timestamp: string;
        fileDate?: string;
    },
): Promise<void> {
    const fileDate = opts.fileDate ?? opts.timestamp.slice(0, 10);
    const [year, month, day] = fileDate.split('-');
    const sessionDir = join(codexHomeDir, 'sessions', year, month, day);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
        join(sessionDir, `rollout-${opts.timestamp}-${opts.id}.jsonl`),
        JSON.stringify({
            timestamp: opts.timestamp,
            type: 'session_meta',
            payload: {
                id: opts.id,
                cwd: opts.cwd,
                timestamp: opts.timestamp,
                originator: 'codex-tui',
            },
        }) + '\n',
    );
}

describe('discoverCodexThreadId', () => {
    it('chooses the one new Codex session matching cwd and launch window', async () => {
        const codexHomeDir = await mkdtemp(join(tmpdir(), 'happy-codex-home-'));
        await writeSessionMeta(codexHomeDir, {
            id: 'thread-outside-date-directories',
            cwd: '/workspace/project',
            timestamp: '2026-05-03T11:00:01.000Z',
        });
        await writeSessionMeta(codexHomeDir, {
            id: 'thread-before-window',
            cwd: '/workspace/project',
            timestamp: '2026-05-04T10:59:59.000Z',
        });
        await writeSessionMeta(codexHomeDir, {
            id: 'thread-other-cwd',
            cwd: '/workspace/other',
            timestamp: '2026-05-04T11:00:01.000Z',
        });
        await writeSessionMeta(codexHomeDir, {
            id: 'thread-match',
            cwd: '/workspace/project',
            timestamp: '2026-05-04T11:00:01.000Z',
        });

        await expect(discoverCodexThreadId({
            codexHomeDir,
            cwd: '/workspace/project',
            startedAt: new Date('2026-05-04T11:00:00.000Z'),
            finishedAt: new Date('2026-05-04T11:00:05.000Z'),
        })).resolves.toEqual('thread-match');
    });

    it('checks both start and finish date directories for windows crossing midnight', async () => {
        const codexHomeDir = await mkdtemp(join(tmpdir(), 'happy-codex-home-'));
        await writeSessionMeta(codexHomeDir, {
            id: 'thread-after-midnight',
            cwd: '/workspace/project',
            timestamp: '2026-05-05T00:00:01.000Z',
        });

        await expect(discoverCodexThreadId({
            codexHomeDir,
            cwd: '/workspace/project',
            startedAt: new Date('2026-05-04T23:59:59.000Z'),
            finishedAt: new Date('2026-05-05T00:00:05.000Z'),
        })).resolves.toEqual('thread-after-midnight');
    });

    it('rejects when no matching new Codex session appears', async () => {
        const codexHomeDir = await mkdtemp(join(tmpdir(), 'happy-codex-home-'));
        await writeSessionMeta(codexHomeDir, {
            id: 'thread-other-cwd',
            cwd: '/workspace/other',
            timestamp: '2026-05-04T11:00:01.000Z',
        });

        await expect(discoverCodexThreadId({
            codexHomeDir,
            cwd: '/workspace/project',
            startedAt: new Date('2026-05-04T11:00:00.000Z'),
            finishedAt: new Date('2026-05-04T11:00:05.000Z'),
        })).rejects.toThrow('Could not discover Codex thread id');
    });

    it('rejects when multiple matching new Codex sessions appear', async () => {
        const codexHomeDir = await mkdtemp(join(tmpdir(), 'happy-codex-home-'));
        await writeSessionMeta(codexHomeDir, {
            id: 'thread-one',
            cwd: '/workspace/project',
            timestamp: '2026-05-04T11:00:01.000Z',
        });
        await writeSessionMeta(codexHomeDir, {
            id: 'thread-two',
            cwd: '/workspace/project',
            timestamp: '2026-05-04T11:00:02.000Z',
        });

        await expect(discoverCodexThreadId({
            codexHomeDir,
            cwd: '/workspace/project',
            startedAt: new Date('2026-05-04T11:00:00.000Z'),
            finishedAt: new Date('2026-05-04T11:00:05.000Z'),
        })).rejects.toThrow('Ambiguous Codex thread discovery');
    });
});
