import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveCodexResumeContext } from './resumeContext';

async function createRollout(params: {
    root: string;
    threadId: string;
    cwd: string;
}) {
    const sessionsDir = join(params.root, 'sessions', '2026', '03', '03');
    await mkdir(sessionsDir, { recursive: true });
    const rolloutPath = join(
        sessionsDir,
        `rollout-2026-03-03T09-53-41-${params.threadId}.jsonl`,
    );
    await writeFile(
        rolloutPath,
        JSON.stringify({
            type: 'session_meta',
            payload: {
                id: params.threadId,
                cwd: params.cwd,
            },
        }) + '\n',
        'utf8',
    );
    return rolloutPath;
}

describe('resolveCodexResumeContext', () => {
    let tempDir: string | null = null;

    afterEach(async () => {
        if (tempDir) {
            await import('node:fs/promises').then(({ rm }) => rm(tempDir!, { recursive: true, force: true }));
            tempDir = null;
        }
    });

    it('throws a codex-like error when no saved rollout exists', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'codex-resume-context-'));

        await expect(resolveCodexResumeContext({
            threadId: 'missing-thread',
            currentCwd: '/tmp/current',
            interactive: false,
            codexHomeDir: tempDir,
        })).rejects.toThrow(
            'No saved Codex session found with ID missing-thread. Run `codex resume` without an ID to choose from existing sessions.',
        );
    });

    it('defaults to the saved session directory when it exists and there is no TTY prompt', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'codex-resume-context-'));
        const savedCwd = join(tempDir, 'workspace');
        await mkdir(savedCwd, { recursive: true });
        const rolloutPath = await createRollout({
            root: tempDir,
            threadId: 'thread-1',
            cwd: savedCwd,
        });

        const result = await resolveCodexResumeContext({
            threadId: 'thread-1',
            currentCwd: '/tmp/current',
            interactive: false,
            codexHomeDir: tempDir,
        });

        expect(result).toEqual({
            threadId: 'thread-1',
            rolloutPath,
            savedCwd,
            selectedCwd: savedCwd,
        });
    });

    it('falls back to the current directory when the saved session directory is missing', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'codex-resume-context-'));
        const rolloutPath = await createRollout({
            root: tempDir,
            threadId: 'thread-2',
            cwd: '/missing/workspace',
        });

        const result = await resolveCodexResumeContext({
            threadId: 'thread-2',
            currentCwd: '/tmp/current',
            interactive: false,
            codexHomeDir: tempDir,
        });

        expect(result).toEqual({
            threadId: 'thread-2',
            rolloutPath,
            savedCwd: '/missing/workspace',
            selectedCwd: '/tmp/current',
        });
    });

    it('uses the interactive chooser when the saved and current directories differ', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'codex-resume-context-'));
        const savedCwd = join(tempDir, 'workspace');
        await mkdir(savedCwd, { recursive: true });
        await createRollout({
            root: tempDir,
            threadId: 'thread-3',
            cwd: savedCwd,
        });

        const result = await resolveCodexResumeContext({
            threadId: 'thread-3',
            currentCwd: '/tmp/current',
            interactive: true,
            codexHomeDir: tempDir,
            chooseDirectory: async () => 'current',
        });

        expect(result.selectedCwd).toBe('/tmp/current');
        expect(result.savedCwd).toBe(savedCwd);
    });
});
