import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backfillUnsyncedTranscript, collectSyncedTranscript, unsyncedEntryIndexes } from './transcriptResync';
import { getProjectPath } from './path';

const agent = (claudeUuid: string, text: string) => ({ role: 'session', content: { role: 'agent', claudeUuid, ev: { t: 'text', text } } });
const appUser = (text: string) => ({ role: 'user', content: { type: 'text', text } });
const user = (uuid: string, text: string) => ({ type: 'user', uuid, message: { content: text } });
const assistant = (uuid: string) => ({ type: 'assistant', uuid, message: { content: [] } });

describe('collectSyncedTranscript', () => {
    it('collects claudeUuids and the app-typed user texts after the last one', () => {
        const synced = collectSyncedTranscript([appUser('hello'), agent('a1', 'Hi!'), appUser('again'), appUser('more')]);
        expect([...synced.claudeUuids]).toEqual(['a1']);
        expect(synced.trailingUserTexts).toEqual(['again', 'more']);
    });

    it('ignores bodies it does not understand', () => {
        expect(collectSyncedTranscript([null, 'x', { role: 'session', content: { ev: { t: 'turn-start' } } }])).toEqual({
            claudeUuids: new Set(),
            trailingUserTexts: [],
        });
    });
});

describe('unsyncedEntryIndexes', () => {
    const synced = collectSyncedTranscript([appUser('hello'), agent('a1', 'Hi!')]);

    it('returns the entries added after the last one the history knows', () => {
        const entries = [user('u1', 'hello'), assistant('a1'), user('u2', 'outside'), assistant('a2')];
        expect(unsyncedEntryIndexes(entries, synced)).toEqual([2, 3]);
    });

    it('returns nothing when nothing was added', () => {
        expect(unsyncedEntryIndexes([user('u1', 'hello'), assistant('a1')], synced)).toEqual([]);
    });

    it('does not resend an app-typed message that never got a reply', () => {
        const pending = collectSyncedTranscript([appUser('hello'), agent('a1', 'Hi!'), appUser('still there?')]);
        const entries = [user('u1', 'hello'), assistant('a1'), user('u2', 'still there?'), user('u3', 'outside')];
        expect(unsyncedEntryIndexes(entries, pending)).toEqual([3]);
    });

    it('returns null when the history knows none of the entries', () => {
        expect(unsyncedEntryIndexes([user('x1', 'other'), assistant('x2')], synced)).toBeNull();
    });
});

describe('backfillUnsyncedTranscript', () => {
    let dir: string;
    let previousConfigDir: string | undefined;
    const entry = (type: 'user' | 'assistant', uuid: string, text: string) => JSON.stringify(type === 'user'
        ? { type, uuid, sessionId: 'c1', message: { role: 'user', content: text }, timestamp: new Date().toISOString() }
        : { type, uuid, sessionId: 'c1', message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp: new Date().toISOString() });

    beforeEach(async () => {
        dir = join(tmpdir(), `backfill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = join(dir, 'config');
        await mkdir(getProjectPath(join(dir, 'work')), { recursive: true });
        await writeFile(join(getProjectPath(join(dir, 'work')), 'c1.jsonl'), [
            entry('user', 'u1', 'hello'),                  // sent to the app before happy stopped
            entry('assistant', 'a1', 'Hi!'),               // sent to the app before happy stopped
            entry('user', 'u2', 'outside message'),        // added later with plain `claude --resume c1`
            entry('assistant', 'a2', 'reply to outside'),  // added later with plain `claude --resume c1`
        ].join('\n') + '\n');
    });

    afterEach(async () => {
        if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
        await rm(dir, { recursive: true, force: true });
    });

    const run = async (synced: Promise<ReturnType<typeof collectSyncedTranscript>> | null) => {
        const sent: string[] = [];
        const count = await backfillUnsyncedTranscript({
            synced,
            workingDirectory: join(dir, 'work'),
            claudeSessionId: 'c1',
            send: async (message) => { sent.push((message as { uuid: string }).uuid); },
            timeoutMs: 200,
        });
        return { count, sent };
    };

    it('sends the messages added while happy was not running (slopus/happy#1861)', async () => {
        const synced = collectSyncedTranscript([appUser('hello'), agent('a1', 'Hi!')]);
        expect(await run(Promise.resolve(synced))).toEqual({ count: 2, sent: ['u2', 'a2'] });
    });

    it('sends nothing when not reattaching, or when the history cannot be read', async () => {
        expect(await run(null)).toEqual({ count: 0, sent: [] });
        expect(await run(Promise.reject(new Error('offline')))).toEqual({ count: 0, sent: [] });
        expect(await run(new Promise(() => {}))).toEqual({ count: 0, sent: [] });
    });
});
