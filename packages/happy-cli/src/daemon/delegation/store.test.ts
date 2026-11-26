import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '@/ui/logger';
import { createDelegationStore, readDelegationJson, type StoredDelegationTask } from './store';

const directories: string[] = [];
afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'paws-delegation-store-'));
    directories.push(directory);
    return { directory, store: createDelegationStore(directory) };
}
function task(versions = 1, text = 'Task data'): StoredDelegationTask {
    return {
        id: randomUUID(), parentSessionId: 'parent-one', title: 'Stored task', nonce: 'a'.repeat(64), createdAt: 1,
        childSessionId: 'child-one',
        role: { id: 'writer', name: 'Writer', description: 'Write verified documentation.', agent: 'codex', autoDelegate: false, createdAt: 1, updatedAt: 1 },
        versions: Array.from({ length: versions }, (_, index) => ({
            version: index + 1, requestId: `request-${index + 1}`, inputHash: 'b'.repeat(64), phase: 'sent', reportSequence: 1,
            intent: 'explicit', prompt: text, context: text, result: { text }, status: 'completed', startedAt: 1, updatedAt: 2, finishedAt: 2,
        })),
    };
}
const filename = (value: StoredDelegationTask) => `task-${value.id}.json`;

describe('delegation task history storage', () => {
    it('reloads legal Chinese history above the common journal reader limit', () => {
        const f = fixture();
        const value = task(30);
        for (const version of value.versions) {
            version.prompt = '文'.repeat(100_000);
            version.context = '境'.repeat(100_000);
            version.result = { text: '果'.repeat(200_000) };
        }
        f.store.saveTask(value);
        expect(statSync(join(f.directory, 'tasks', filename(value))).size).toBeGreaterThan(32 * 1024 * 1024);
        expect(() => readDelegationJson(join(f.directory, 'tasks'), filename(value))).toThrow('Unsafe delegation record');

        const restored = createDelegationStore(f.directory).loadTasks();
        expect(restored).toHaveLength(1);
        expect(restored[0].versions).toHaveLength(30);
        expect(restored[0].versions[0].prompt).toBe('文'.repeat(100_000));
        expect(restored[0].versions[29].context).toBe('境'.repeat(100_000));
        expect(restored[0].versions[29].result?.text).toBe('果'.repeat(200_000));
    });

    it('reloads all 100 full-length revisions including worst-case JSON string escapes', () => {
        const f = fixture();
        const value = task(100);
        for (const version of value.versions) {
            version.prompt = '\u0000'.repeat(100_000);
            version.context = '\u0000'.repeat(100_000);
            version.result = { text: '\u0000'.repeat(200_000), turnId: 'turn-one', truncated: false };
            version.error = '\u0000'.repeat(4_000);
            version.turnId = '\u0000'.repeat(256);
        }
        f.store.saveTask(value);
        const bytes = statSync(join(f.directory, 'tasks', filename(value))).size;
        expect(bytes).toBeGreaterThan(240_000_000);
        expect(bytes).toBeLessThan(256 * 1024 * 1024);

        const restored = createDelegationStore(f.directory).loadTasks();
        expect(restored).toHaveLength(1);
        expect(restored[0].versions).toHaveLength(100);
        expect(restored[0].versions[99].prompt).toBe('\u0000'.repeat(100_000));
        expect(restored[0].versions[99].result?.text).toBe('\u0000'.repeat(200_000));
        expect(restored[0].versions[99].error).toBe('\u0000'.repeat(4_000));
    }, 30_000);

    it('loads healthy tasks beside invalid JSON, schema violations, oversized files and symlinks without changing originals', () => {
        const f = fixture();
        const warning = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        const healthy = task();
        f.store.saveTask(healthy);
        const broken = task();
        const brokenPath = join(f.directory, 'tasks', filename(broken));
        const brokenContents = '{"prompt":"private-task-body",';
        writeFileSync(brokenPath, brokenContents);
        const invalid = task();
        const invalidPath = join(f.directory, 'tasks', filename(invalid));
        const invalidContents = JSON.stringify({ ...invalid, versions: [{ ...invalid.versions[0], prompt: { private: 'private-task-body' } }] });
        writeFileSync(invalidPath, invalidContents);
        const oversized = task();
        const oversizedPath = join(f.directory, 'tasks', filename(oversized));
        writeFileSync(oversizedPath, '');
        truncateSync(oversizedPath, 256 * 1024 * 1024 + 1);
        const linked = task();
        const linkedPath = join(f.directory, 'tasks', filename(linked));
        const originalPath = join(f.directory, 'original.json');
        const originalContents = JSON.stringify(linked);
        writeFileSync(originalPath, originalContents);
        symlinkSync(originalPath, linkedPath);

        expect(f.store.loadTasks().map(value => value.id)).toEqual([healthy.id]);
        for (const value of [broken, invalid, oversized, linked]) expect(() => f.store.saveTask(value)).toThrow(/unreadable.*reload/i);
        expect(readFileSync(brokenPath, 'utf8')).toBe(brokenContents);
        expect(readFileSync(invalidPath, 'utf8')).toBe(invalidContents);
        expect(statSync(oversizedPath).size).toBe(256 * 1024 * 1024 + 1);
        expect(lstatSync(linkedPath).isSymbolicLink()).toBe(true);
        expect(readFileSync(originalPath, 'utf8')).toBe(originalContents);
        expect(warning).toHaveBeenCalledTimes(4);
        const diagnostics = JSON.stringify(warning.mock.calls);
        for (const value of [broken, invalid, oversized, linked]) expect(diagnostics).toContain(filename(value));
        expect(diagnostics).toContain('invalid-json');
        expect(diagnostics).toContain('invalid-schema');
        expect(diagnostics).toContain('unsafe-record');
        expect(diagnostics).not.toContain('private-task-body');
    });

    it.each([
        ['task title', (value: StoredDelegationTask) => ({ ...value, title: null })],
        ['child identity', (value: StoredDelegationTask) => ({ ...value, childSessionId: { unexpected: 'object' } })],
        ['creation time', (value: StoredDelegationTask) => ({ ...value, createdAt: 'invalid' })],
        ['temporary route flag', (value: StoredDelegationTask) => ({ ...value, temporaryRoute: 'invalid' })],
        ['cancellation flag', (value: StoredDelegationTask) => ({ ...value, versions: [{ ...value.versions[0], cancelRequested: 'invalid' }] })],
        ['internal turn identity', (value: StoredDelegationTask) => ({ ...value, versions: [{ ...value.versions[0], turnId: 'x'.repeat(257) }] })],
    ])('isolates corrupt %s metadata before it can reach the coordinator', (_field, corrupt) => {
        const f = fixture();
        vi.spyOn(logger, 'warn').mockImplementation(() => {});
        const healthy = task();
        const invalid = task();
        f.store.saveTask(healthy);
        const path = join(f.directory, 'tasks', filename(invalid));
        const contents = JSON.stringify(corrupt(invalid));
        writeFileSync(path, contents);
        expect(f.store.loadTasks().map(value => value.id)).toEqual([healthy.id]);
        expect(readFileSync(path, 'utf8')).toBe(contents);
    });

    it('isolates a filename-matching task ID that cannot be published through the shared wire schema', () => {
        const f = fixture();
        vi.spyOn(logger, 'warn').mockImplementation(() => {});
        const healthy = task();
        f.store.saveTask(healthy);
        const invalid = { ...task(), id: `-${'a'.repeat(35)}` };
        const path = join(f.directory, 'tasks', filename(invalid));
        const contents = JSON.stringify(invalid);
        writeFileSync(path, contents);

        expect(f.store.loadTasks().map(value => value.id)).toEqual([healthy.id]);
        expect(readFileSync(path, 'utf8')).toBe(contents);
    });

    it('preserves a rejected record until it is repaired and successfully loaded again', () => {
        const f = fixture();
        vi.spyOn(logger, 'warn').mockImplementation(() => {});
        const value = task();
        const path = join(f.directory, 'tasks', filename(value));
        const original = '{broken original';
        writeFileSync(path, original);
        expect(f.store.loadTasks()).toEqual([]);
        expect(() => f.store.saveTask(value)).toThrow(/unreadable.*reload/i);
        expect(readFileSync(path, 'utf8')).toBe(original);

        writeFileSync(path, JSON.stringify(value));
        expect(() => f.store.saveTask(value)).toThrow(/unreadable.*reload/i);
        expect(f.store.loadTasks().map(loaded => loaded.id)).toEqual([value.id]);
        value.versions[0].result = { text: 'Saved after repair' };
        f.store.saveTask(value);
        expect(f.store.loadTasks()[0].versions[0].result?.text).toBe('Saved after repair');
    });
});
