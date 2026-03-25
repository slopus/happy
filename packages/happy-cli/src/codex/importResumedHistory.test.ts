import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { importResumedCodexHistory } from './importResumedHistory';

describe('importResumedCodexHistory', () => {
    let tempDir: string | null = null;

    afterEach(async () => {
        if (tempDir) {
            await rm(tempDir, { recursive: true, force: true });
            tempDir = null;
        }
    });

    it('imports user and agent event messages from the saved rollout', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'codex-rollout-'));
        const rolloutPath = join(tempDir, 'rollout.jsonl');
        await writeFile(rolloutPath, [
            JSON.stringify({
                timestamp: '2026-03-03T10:00:00.000Z',
                type: 'event_msg',
                payload: { type: 'user_message', message: 'hello' },
            }),
            JSON.stringify({
                timestamp: '2026-03-03T10:00:01.000Z',
                type: 'event_msg',
                payload: { type: 'agent_message', message: 'world' },
            }),
        ].join('\n'));

        const session = {
            sendImportedCodexHistoryMessage: vi.fn(),
            flush: vi.fn(async () => {}),
        };
        const messageBuffer = {
            addMessage: vi.fn(),
        };

        const result = await importResumedCodexHistory({
            rolloutPath,
            session,
            messageBuffer,
        });

        expect(result).toEqual({ importedCount: 2 });
        expect(session.flush).toHaveBeenCalledTimes(1);
        expect(session.sendImportedCodexHistoryMessage).toHaveBeenCalledTimes(2);
        expect(session.sendImportedCodexHistoryMessage).toHaveBeenNthCalledWith(1, {
            role: 'user',
            text: 'hello',
            uuid: 'codex-resume-import-0',
        });
        expect(session.sendImportedCodexHistoryMessage).toHaveBeenNthCalledWith(2, {
            role: 'assistant',
            text: 'world',
            uuid: 'codex-resume-import-1',
        });
        expect(messageBuffer.addMessage).toHaveBeenCalledWith('Restored 2 chat messages from saved Codex session.', 'status');
        expect(messageBuffer.addMessage).toHaveBeenCalledWith('hello', 'user');
        expect(messageBuffer.addMessage).toHaveBeenCalledWith('world', 'assistant');
    });
});
