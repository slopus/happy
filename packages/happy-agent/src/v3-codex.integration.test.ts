/**
 * v3 Codex Integration Test
 *
 * Spawns a real Codex session with HAPPY_V3_PROTOCOL=1, sends prompts,
 * and verifies that v3 envelopes appear in history with correct structure.
 *
 * Requires a booted environment (yarn env:up:authenticated).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeBase64 } from './encryption';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(__dirname, '..');
const repoRoot = resolve(packageDir, '..', '..');
const environmentsDir = join(repoRoot, 'environments', 'data', 'envs');
const currentEnvironmentPath = join(repoRoot, 'environments', 'data', 'current.json');
const binPath = resolve(packageDir, 'bin', 'happy-agent.mjs');
const keepEnv = ['1', 'true', 'yes'].includes((process.env.HAPPY_AGENT_KEEP_ENV ?? '').toLowerCase());

type EnvironmentConfig = { name: string; serverPort: number; expoPort: number };
type DaemonState = { httpPort?: number; pid?: number };
type HistoryMessage = { id: string; seq: number; content: unknown; localId: string | null; createdAt: number; updatedAt: number };

let previousCurrentEnv: string | null = null;
let integrationEnvName: string | null = null;
let integrationEnvDir: string | null = null;
let integrationConfig: EnvironmentConfig | null = null;
let agentHomeDir: string | null = null;
let activeMachineId: string | null = null;
let labRatProjectDir: string | null = null;
let codexSessionId: string | null = null;
const spawnedSessionIds = new Set<string>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function runYarn(args: string[], cwd = repoRoot): string {
    const result = spawnSync('yarn', args, { cwd, env: process.env, encoding: 'utf-8', maxBuffer: 20_000_000 });
    if (result.status !== 0) {
        throw new Error(`yarn ${args.join(' ')} failed (code ${result.status})\n${result.stdout}\n${result.stderr}`);
    }
    return result.stdout;
}

function readCurrentEnvName(): string | null {
    if (!existsSync(currentEnvironmentPath)) return null;
    return (JSON.parse(readFileSync(currentEnvironmentPath, 'utf-8')) as { current?: string }).current ?? null;
}

function environmentExists(name: string): boolean {
    return existsSync(join(environmentsDir, name, 'environment.json'));
}

function readEnvironmentConfig(name: string): EnvironmentConfig {
    return JSON.parse(readFileSync(join(environmentsDir, name, 'environment.json'), 'utf-8')) as EnvironmentConfig;
}

function readDaemonState(envDir: string): DaemonState | null {
    const p = join(envDir, 'cli', 'home', 'daemon.state.json');
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) as DaemonState : null;
}

function agentEnv(): NodeJS.ProcessEnv {
    return {
        ...process.env,
        HAPPY_SERVER_URL: `http://localhost:${integrationConfig!.serverPort}`,
        HAPPY_HOME_DIR: agentHomeDir!,
        HAPPY_V3_PROTOCOL: '1',
    };
}

function agent(args: string[]): string {
    return execFileSync(process.execPath, ['--no-warnings', '--no-deprecation', binPath, ...args], {
        env: agentEnv(),
        encoding: 'utf-8',
        maxBuffer: 10_000_000,
    });
}

function agentJson<T>(args: string[]): T {
    return JSON.parse(agent([...args, '--json'])) as T;
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs: number, label: string): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await check()) return;
        await new Promise(r => setTimeout(r, 500));
    }
    throw new Error(`Timed out waiting for ${label}`);
}

async function stopDaemonSession(httpPort: number, sessionId: string): Promise<void> {
    await fetch(`http://127.0.0.1:${httpPort}/stop-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
    }).catch(() => {});
}

function getHistory(): HistoryMessage[] {
    return agentJson<HistoryMessage[]>(['history', codexSessionId!]);
}

function isV3Envelope(content: unknown): content is { v: 3; message: { info: unknown; parts: unknown[] } } {
    if (!content || typeof content !== 'object') return false;
    const c = content as Record<string, unknown>;
    return c.v === 3 && c.message != null && typeof c.message === 'object';
}

function getV3Messages(): Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> {
    return getHistory()
        .filter(m => isV3Envelope(m.content))
        .map(m => (m.content as { v: 3; message: { info: Record<string, unknown>; parts: Array<Record<string, unknown>> } }).message);
}

function getV3AssistantMessages() {
    return getV3Messages().filter(m => (m.info as any).role === 'assistant');
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('v3 Codex end-to-end', { timeout: 600_000 }, () => {
    beforeAll(async () => {
        previousCurrentEnv = readCurrentEnvName();
        runYarn(['env:up:authenticated']);

        integrationEnvName = readCurrentEnvName();
        if (!integrationEnvName) throw new Error('Failed to determine integration environment name');

        integrationEnvDir = join(environmentsDir, integrationEnvName);
        integrationConfig = readEnvironmentConfig(integrationEnvName);
        agentHomeDir = join(integrationEnvDir, 'cli', 'home');
        labRatProjectDir = join(integrationEnvDir, 'project');

        if (keepEnv) {
            console.log(`[v3-codex] environment: ${integrationEnvName} at ${integrationEnvDir}`);
        }

        // Wait for machine to be ready
        const machines = agentJson<Array<{ id: string; active: boolean; metadata?: { resumeSupport?: { rpcAvailable?: boolean } } }>>(['machines']);
        const machine = machines.find(m => m.active) ?? machines[0];
        activeMachineId = machine.id;

        await waitFor(async () => {
            const refreshed = agentJson<typeof machines>(['machines']);
            const m = refreshed.find(item => item.id === activeMachineId);
            return m?.metadata?.resumeSupport?.rpcAvailable === true;
        }, 30_000, 'machine to advertise RPC support');

        // Spawn Codex session against lab-rat project
        const result = agentJson<{ type: string; sessionId?: string }>([
            'spawn',
            '--machine', activeMachineId!,
            '--path', labRatProjectDir!,
            '--agent', 'codex',
        ]);
        expect(result.type).toBe('success');
        codexSessionId = result.sessionId!;
        spawnedSessionIds.add(codexSessionId);

        // Wait for session to appear
        await waitFor(async () => {
            const sessions = agentJson<Array<{ id: string }>>(['list']);
            return sessions.some(s => s.id === codexSessionId);
        }, 20_000, 'codex session to appear in list');
    });

    afterAll(async () => {
        if (keepEnv) return;
        try {
            if (integrationEnvDir) {
                const ds = readDaemonState(integrationEnvDir);
                if (ds?.httpPort) {
                    for (const sid of spawnedSessionIds) {
                        await stopDaemonSession(ds.httpPort, sid);
                    }
                }
            }
        } finally {
            if (integrationEnvName) {
                try { runYarn(['env:down']); } catch {}
                try { runYarn(['env:remove', integrationEnvName]); } catch {}
            }
            if (previousCurrentEnv && previousCurrentEnv !== integrationEnvName && environmentExists(previousCurrentEnv)) {
                try { runYarn(['env:use', previousCurrentEnv]); } catch {}
            }
        }
    });

    // ── TRANSCRIPT ──────────────────────────────────────────

    it('step 1: orient — v3 envelope with text parts', async () => {
        agent(['send', codexSessionId!, 'Read all files in this project, tell me what it does', '--wait']);

        const v3Msgs = getV3Messages();
        expect(v3Msgs.length).toBeGreaterThan(0);

        const asstMsgs = getV3AssistantMessages();
        expect(asstMsgs.length).toBeGreaterThan(0);

        // Should have text parts
        const lastAsst = asstMsgs[asstMsgs.length - 1];
        const textParts = lastAsst.parts.filter(p => p.type === 'text');
        expect(textParts.length).toBeGreaterThan(0);
    });

    it('step 2: find bug — text mentions the bug', async () => {
        agent(['send', codexSessionId!, 'There is a bug in the Done filter in app.js. Find it and explain.', '--wait']);

        const asstMsgs = getV3AssistantMessages();
        const lastAsst = asstMsgs[asstMsgs.length - 1];
        const textParts = lastAsst.parts.filter(p => p.type === 'text');
        const allText = textParts.map(p => (p as any).text).join(' ').toLowerCase();
        expect(allText).toMatch(/done|filter|bug/i);
    });

    it('step 3: edit with yolo — tool part completed, file changed', async () => {
        agent(['send', codexSessionId!, "Add a comment '// codex v3 test' to the top of app.js", '--yolo', '--wait']);

        const asstMsgs = getV3AssistantMessages();
        const lastAsst = asstMsgs[asstMsgs.length - 1];
        const toolParts = lastAsst.parts.filter(p => p.type === 'tool');

        // Should have at least one tool (patch or exec)
        expect(toolParts.length).toBeGreaterThan(0);

        // Tool should be completed
        const completed = toolParts.find(tp => (tp.state as any).status === 'completed');
        expect(completed).toBeTruthy();

        // Verify file change
        const appJs = readFileSync(join(labRatProjectDir!, 'app.js'), 'utf-8');
        expect(appJs).toContain('codex v3 test');
    });

    it('step 4: tool with output — bash result captured', async () => {
        agent(['send', codexSessionId!, 'Run: echo codex-v3-bash-test', '--yolo', '--wait']);

        const asstMsgs = getV3AssistantMessages();
        const lastAsst = asstMsgs[asstMsgs.length - 1];
        const toolParts = lastAsst.parts.filter(p => p.type === 'tool');

        const bashTool = toolParts.find(tp => {
            const state = tp.state as Record<string, unknown>;
            return state.status === 'completed' && typeof state.output === 'string' && (state.output as string).includes('codex-v3-bash-test');
        });
        expect(bashTool).toBeTruthy();
    });

    // ── PERSISTENCE ─────────────────────────────────────────

    it('dual write — history has both v1 and v3 envelopes', () => {
        const history = getHistory();
        const v3Count = history.filter(m => isV3Envelope(m.content)).length;
        const v1Count = history.filter(m => {
            const c = m.content as Record<string, unknown> | null;
            return c && (c.role === 'session' || c.role === 'user' || c.role === 'agent');
        }).length;

        expect(v3Count).toBeGreaterThan(0);
        expect(v1Count).toBeGreaterThan(0);
    });

    it('v3 messages have correct Codex structure', () => {
        const v3Msgs = getV3Messages();

        for (const msg of v3Msgs) {
            expect(msg.info).toBeDefined();
            expect((msg.info as any).id).toBeTruthy();
            expect((msg.info as any).sessionID).toBeTruthy();
            expect((msg.info as any).role).toMatch(/^(user|assistant)$/);

            expect(Array.isArray(msg.parts)).toBe(true);
            expect(msg.parts.length).toBeGreaterThan(0);

            for (const part of msg.parts) {
                expect(part.id).toBeTruthy();
                expect(part.type).toBeTruthy();
            }
        }

        // Codex assistant messages should have providerID = openai
        const asstMsgs = getV3AssistantMessages();
        if (asstMsgs.length > 0) {
            expect((asstMsgs[0].info as any).providerID).toBe('openai');
        }
    });
});
