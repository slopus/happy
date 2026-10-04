import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { prepareCodexIngestHost } from './codexIngestHost';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture(body = `return { importedPrompts: 1, importedResponses: 1, skippedDuplicates: 0, completedTurns: 1 };`) {
    const root = mkdtempSync(join(tmpdir(), 'happy-codex-ingest-'));
    directories.push(root);
    mkdirSync(join(root, 'services'));
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    const entry = join(root, 'services', 'codex-host-ingest.js');
    writeFileSync(entry, `export const CML_CODEX_INGEST_CAPABILITIES = { version: 1, completedTurnsOnly: true };
        export async function importCodexCompletedTurns(input) { ${body} }`);
    const options = {
        accountOwned: true, sandboxEnabled: true, sandboxPolicyMode: 'owner-choice' as const,
        projectPath: root, env: { CLAUDE_MEMORY_RECALL_OWNER: 'host', CLAUDE_MEMORY_DEBUG: '1' },
        deps: {
            resolveEntry: vi.fn(async () => join(root, 'services', 'lesson-host-service.js')),
            load: vi.fn(async () => ({
                CML_CODEX_INGEST_CAPABILITIES: { version: 1, completedTurnsOnly: true },
                importCodexCompletedTurns: vi.fn(),
            })),
        },
    };
    return { root, entry, options };
}
const request = (root: string, throughTurnId = 'turn-1', threadId = 'native-thread') => ({
    threadId, transcriptPath: join(root, 'private-rollout.jsonl'), throughTurnId,
});

describe('Codex completed-turn memory host', () => {
    it('gates account ownership, sandbox policy, installed artifacts and completed-only capability', async () => {
        const { root, entry, options } = fixture();
        for (const changes of [{ accountOwned: false }, { sandboxEnabled: false }, { sandboxPolicyMode: 'mandatory' as const }]) {
            expect(await prepareCodexIngestHost({ ...options, ...changes })).toBeNull();
        }
        expect(options.deps.resolveEntry).not.toHaveBeenCalled();
        for (const capability of [undefined, { version: 2, completedTurnsOnly: true }, { version: 1, completedTurnsOnly: false }]) {
            expect(await prepareCodexIngestHost({ ...options, deps: { ...options.deps,
                load: async () => ({ CML_CODEX_INGEST_CAPABILITIES: capability, importCodexCompletedTurns: vi.fn() }),
            } })).toBeNull();
        }
        expect(await prepareCodexIngestHost({ ...options, deps: { ...options.deps,
            load: async () => ({ CML_CODEX_INGEST_CAPABILITIES: { version: 1, completedTurnsOnly: true } }),
        } })).toBeNull();
        rmSync(entry);
        expect(await prepareCodexIngestHost(options)).toBeNull();
        expect(await prepareCodexIngestHost({ ...options, deps: { resolveEntry: async () => null } })).toBeNull();
        expect(await prepareCodexIngestHost({ ...options, deps: { resolveEntry: async () => { throw new Error(root); } } })).toBeNull();
    });

    it('bounds a stalled optional handshake without opening a memory service in the parent', async () => {
        const { options } = fixture();
        expect(await prepareCodexIngestHost({ ...options, prepareBudgetMs: 25,
            deps: { ...options.deps, load: () => new Promise(() => {}) },
        })).toBeNull();
        const operation = options.deps.load.mock.results;
        expect(operation).toHaveLength(0);
    });

    it('runs a fixed Node worker with captured host environment and trusted scope via stdin only', async () => {
        const { root, entry, options } = fixture(`
            const { writeFileSync } = await import('node:fs');
            writeFileSync(input.projectPath + '/received.json', JSON.stringify({ input,
                owner: process.env.CLAUDE_MEMORY_RECALL_OWNER, debug: process.env.CLAUDE_MEMORY_DEBUG, cwd: process.cwd() }));
            return { importedPrompts: 2, importedResponses: 1, skippedDuplicates: 3, completedTurns: 2 };
        `);
        const report = vi.fn();
        const spawnSpy = vi.fn((command: string, args: string[], options: SpawnOptionsWithoutStdio) => spawn(command, args, options));
        const host = await prepareCodexIngestHost({ ...options, report, deps: { ...options.deps, spawn: spawnSpy } });
        expect(host).not.toBeNull();
        options.projectPath = '/model-selected-project';
        options.env.CLAUDE_MEMORY_RECALL_OWNER = 'changed-later';
        try {
            expect(await host!.ingest(request(root))).toEqual({ reason: 'imported',
                importedPrompts: 2, importedResponses: 1, skippedDuplicates: 3, completedTurns: 2 });
            const received = JSON.parse(readFileSync(join(root, 'received.json'), 'utf8'));
            expect(received.input).toEqual({ projectPath: root, transcriptPath: request(root).transcriptPath,
                sessionId: 'native-thread', throughTurnId: 'turn-1' });
            expect(received.owner).toBe('host-worker');
            expect(received.debug).toBeUndefined();
            expect(spawnSpy.mock.calls[0][0]).toBe(process.execPath);
            expect(spawnSpy.mock.calls[0][1]).toEqual(['-e', expect.any(String), entry]);
            expect(spawnSpy.mock.calls[0][1].join(' ')).not.toContain('private-rollout');
            await expect(options.deps.load.mock.results[0].value).resolves.toHaveProperty('importCodexCompletedTurns');
            expect(report.mock.calls).toEqual([[{ reason: 'imported', importedPrompts: 2,
                importedResponses: 1, skippedDuplicates: 3, completedTurns: 2 }]]);
            expect(JSON.stringify(report.mock.calls)).not.toContain(root);
        } finally { await host!.close(); }
    });

    it('serializes active workers and coalesces pending requests to the latest completed prefix', async () => {
        const { root, options } = fixture(`
            const { appendFileSync } = await import('node:fs');
            appendFileSync(input.projectPath + '/turns.jsonl', JSON.stringify({ thread: input.sessionId, turn: input.throughTurnId })+'\\n');
            await new Promise(resolve => setTimeout(resolve, 50));
            return { importedPrompts: 1, importedResponses: 1, skippedDuplicates: 0, completedTurns: 1 };
        `);
        let active = 0;
        let maximumActive = 0;
        const spawnSpy = vi.fn((command: string, args: string[], options: SpawnOptionsWithoutStdio) => {
            active += 1; maximumActive = Math.max(maximumActive, active);
            const child = spawn(command, args, options);
            child.once('close', () => { active -= 1; });
            return child;
        });
        const host = await prepareCodexIngestHost({ ...options, deps: { ...options.deps, spawn: spawnSpy } });
        try {
            const results = await Promise.all([
                host!.ingest(request(root, 'turn-1')),
                host!.ingest(request(root, 'turn-2')),
                host!.ingest(request(root, 'turn-3')),
                host!.ingest(request(root, 'other-turn', 'other-thread')),
            ]);
            expect(results.every(result => result.reason === 'imported')).toBe(true);
            expect(maximumActive).toBe(1);
            expect(spawnSpy).toHaveBeenCalledTimes(3);
            expect(readFileSync(join(root, 'turns.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))).toEqual([
                { thread: 'native-thread', turn: 'turn-1' },
                { thread: 'native-thread', turn: 'turn-3' },
                { thread: 'other-thread', turn: 'other-turn' },
            ]);
        } finally { await host!.close(); }
    });

    it('leaves durable duplicate detection to CML and permits a safe retry', async () => {
        const { root, options } = fixture(`
            const { existsSync, writeFileSync } = await import('node:fs');
            const path = input.projectPath + '/done';
            const duplicate = existsSync(path); writeFileSync(path, 'done');
            return { importedPrompts: duplicate ? 0 : 1, importedResponses: duplicate ? 0 : 1,
                skippedDuplicates: duplicate ? 2 : 0, completedTurns: 1 };
        `);
        const host = await prepareCodexIngestHost(options);
        try {
            expect((await host!.ingest(request(root))).reason).toBe('imported');
            expect(await host!.ingest(request(root))).toEqual({ reason: 'empty',
                importedPrompts: 0, importedResponses: 0, skippedDuplicates: 2, completedTurns: 1 });
        } finally { await host!.close(); }
    });

    it.each([
        ["throw new Error('private prompt/path');", 'ingest_failed'],
        ["process.stdout.write('not-json'); return { importedPrompts: 0, importedResponses: 0, skippedDuplicates: 0, completedTurns: 0 };", 'invalid_output'],
        ["return { importedPrompts: -1, importedResponses: 0, skippedDuplicates: 0, completedTurns: 0 };", 'ingest_failed'],
        ["process.stderr.write('private'.repeat(3000)); return { importedPrompts: 0, importedResponses: 0, skippedDuplicates: 0, completedTurns: 0 };", 'output_limit'],
    ])('classifies worker failure without exposing private output (%s)', async (body, reason) => {
        const { root, options } = fixture(body);
        const report = vi.fn();
        const host = await prepareCodexIngestHost({ ...options, report });
        try {
            expect((await host!.ingest(request(root))).reason).toBe(reason);
            expect(JSON.stringify(report.mock.calls)).not.toContain('private');
            expect(JSON.stringify(report.mock.calls)).not.toContain(root);
        } finally { await host!.close(); }
    });

    it('bounds hung workers, waits for process close, and does not leave a writer behind', async () => {
        const { root, options } = fixture('await new Promise(() => { setInterval(()=>{},1000); });');
        let child: ChildProcessWithoutNullStreams | undefined;
        const host = await prepareCodexIngestHost({ ...options, budgetMs: 100,
            deps: { ...options.deps, spawn: (command, args, options) => child = spawn(command, args, options) },
        });
        try {
            expect((await host!.ingest(request(root))).reason).toBe('timeout');
            expect(child!.signalCode).toBe('SIGKILL');
            expect(() => process.kill(child!.pid!, 0)).toThrow();
        } finally { await host!.close(); }
    });

    it('cancels and joins the active writer at shutdown and refuses queued or later work', async () => {
        const { root, options } = fixture('await new Promise(() => { setInterval(()=>{},1000); });');
        const spawnSpy = vi.fn((command: string, args: string[], options: SpawnOptionsWithoutStdio) => spawn(command, args, options));
        const host = await prepareCodexIngestHost({ ...options, deps: { ...options.deps, spawn: spawnSpy } });
        const active = host!.ingest(request(root));
        const queued = host!.ingest(request(root, 'turn-2'));
        await host!.close();
        expect((await active).reason).toBe('cancelled');
        expect((await queued).reason).toBe('cancelled');
        expect((await host!.ingest(request(root, 'turn-3'))).reason).toBe('cancelled');
        expect(spawnSpy).toHaveBeenCalledOnce();
        expect(spawnSpy.mock.results[0].value.signalCode).toBe('SIGKILL');
        await host!.close();
    });

    it('handles synchronous spawn failures and rejects missing completion identity before spawning', async () => {
        const { root, options } = fixture();
        const spawnSpy = vi.fn(() => { throw new Error('private path'); });
        const host = await prepareCodexIngestHost({ ...options, deps: { ...options.deps, spawn: spawnSpy } });
        try {
            expect((await host!.ingest({ ...request(root), transcriptPath: 'user-controlled-relative' })).reason).toBe('invalid_output');
            expect((await host!.ingest({ ...request(root), throughTurnId: '' })).reason).toBe('invalid_output');
            expect(spawnSpy).not.toHaveBeenCalled();
            expect((await host!.ingest(request(root))).reason).toBe('spawn_failed');
        } finally { await host!.close(); }
    });

    it('ignores an observer failure without changing a successful import', async () => {
        const { root, options } = fixture();
        const host = await prepareCodexIngestHost({ ...options, report: () => { throw new Error('diagnostic failure'); } });
        try { expect((await host!.ingest(request(root))).reason).toBe('imported'); }
        finally { await host!.close(); }
    });
});
