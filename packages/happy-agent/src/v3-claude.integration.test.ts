/**
 * v3 Claude Integration Test
 *
 * Spawns a real Claude session with HAPPY_V3_PROTOCOL=1, exercises the flow
 * from exercise-flow.md, and verifies that v3 envelopes appear in history
 * alongside v1 dual-write messages.
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
let claudeSessionId: string | null = null;
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

function readSeededCliCredentials(envDir: string): { token: string; secret: Uint8Array } {
    const parsed = JSON.parse(readFileSync(join(envDir, 'cli', 'home', 'access.key'), 'utf-8')) as { token: string; secret: string };
    return { token: parsed.token, secret: decodeBase64(parsed.secret) };
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
    return agentJson<HistoryMessage[]>(['history', claudeSessionId!]);
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

function getV3ToolParts() {
    return getV3AssistantMessages().flatMap(m => m.parts.filter(p => p.type === 'tool'));
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('v3 Claude end-to-end', { timeout: 600_000 }, () => {
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
            console.log(`[v3-claude] environment: ${integrationEnvName} at ${integrationEnvDir}`);
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

        // Spawn Claude session against lab-rat project
        const result = agentJson<{ type: string; sessionId?: string }>([
            'spawn',
            '--machine', activeMachineId!,
            '--path', labRatProjectDir!,
        ]);
        expect(result.type).toBe('success');
        claudeSessionId = result.sessionId!;
        spawnedSessionIds.add(claudeSessionId);

        // Wait for session to appear
        await waitFor(async () => {
            const sessions = agentJson<Array<{ id: string }>>(['list']);
            return sessions.some(s => s.id === claudeSessionId);
        }, 20_000, 'claude session to appear in list');
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

    it('step 1: orient — read files, produces v3 text + tool parts', async () => {
        agent(['send', claudeSessionId!, 'Read all files in this project, tell me what it does', '--wait']);

        // Verify v3 envelopes exist
        const v3Msgs = getV3Messages();
        expect(v3Msgs.length).toBeGreaterThan(0);

        // Should have at least one user message and one assistant message
        const userMsgs = v3Msgs.filter(m => (m.info as any).role === 'user');
        const asstMsgs = getV3AssistantMessages();
        expect(userMsgs.length).toBeGreaterThan(0);
        expect(asstMsgs.length).toBeGreaterThan(0);

        // Assistant should have text parts and tool parts (Read)
        const lastAsst = asstMsgs[asstMsgs.length - 1];
        const textParts = lastAsst.parts.filter(p => p.type === 'text');
        const toolParts = lastAsst.parts.filter(p => p.type === 'tool');
        expect(textParts.length).toBeGreaterThan(0);
        expect(toolParts.length).toBeGreaterThan(0);

        // Tools should be completed (they read files, no permission needed)
        for (const tp of toolParts) {
            const state = tp.state as Record<string, unknown>;
            expect(state.status).toBe('completed');
        }

        // Should have step-start and step-finish
        expect(lastAsst.parts.some(p => p.type === 'step-start')).toBe(true);
        expect(lastAsst.parts.some(p => p.type === 'step-finish')).toBe(true);

        // Info should have providerID
        expect((lastAsst.info as any).providerID).toBe('anthropic');
    });

    it('step 2: find the bug — reasoning', async () => {
        agent(['send', claudeSessionId!, 'There is a bug in the Done filter in app.js. Find it and explain.', '--wait']);

        const asstMsgs = getV3AssistantMessages();
        const lastAsst = asstMsgs[asstMsgs.length - 1];
        const textParts = lastAsst.parts.filter(p => p.type === 'text');

        // Should mention the bug (line 88/89, !item.done)
        const allText = textParts.map(p => (p as any).text).join(' ').toLowerCase();
        expect(allText).toMatch(/done|filter|bug|!item\.done|line\s*8[89]/i);
    });

    // ── PERMISSIONS ─────────────────────────────────────────

    it('step 3: edit rejected — tool gets error state with block.decision', async () => {
        // Send a command that will trigger an edit (requires permission)
        agent(['send', claudeSessionId!, 'Fix the bug in app.js. Edit the file.']);

        // Wait for a permission request
        await waitFor(async () => {
            const perms = agentJson<Array<{ id: string; tool: string }>>(['permissions', claudeSessionId!]);
            return perms.length > 0;
        }, 120_000, 'permission request for edit');

        // Get the request ID
        const perms = agentJson<Array<{ id: string; tool: string }>>(['permissions', claudeSessionId!]);
        expect(perms.length).toBeGreaterThan(0);

        // Deny the permission
        agent(['deny', claudeSessionId!, perms[0].id, '--reason', 'show the diff first']);

        // Wait for idle
        agent(['wait', claudeSessionId!]);

        // Check v3 history for the rejected tool
        const toolParts = getV3ToolParts();
        const rejectedTool = toolParts.find(tp => {
            const state = tp.state as Record<string, unknown>;
            return state.status === 'error' && (state.block as any)?.decision === 'reject';
        });
        expect(rejectedTool).toBeTruthy();
    });

    it('step 4: edit approved once — tool completes with block.decision=once', async () => {
        agent(['send', claudeSessionId!, 'Ok apply the fix now.']);

        // Wait for permission
        await waitFor(async () => {
            const perms = agentJson<Array<{ id: string }>>(['permissions', claudeSessionId!]);
            return perms.length > 0;
        }, 120_000, 'permission request for fix');

        const perms = agentJson<Array<{ id: string }>>(['permissions', claudeSessionId!]);
        agent(['approve', claudeSessionId!, perms[0].id]);

        agent(['wait', claudeSessionId!]);

        // Verify the tool completed with once decision
        const toolParts = getV3ToolParts();
        const approvedTool = toolParts.find(tp => {
            const state = tp.state as Record<string, unknown>;
            return state.status === 'completed' && (state.block as any)?.decision === 'once';
        });
        expect(approvedTool).toBeTruthy();

        // Verify app.js was actually changed
        const appJs = readFileSync(join(labRatProjectDir!, 'app.js'), 'utf-8');
        // The bug was !item.done || item.done always being true
        expect(appJs).not.toMatch(/!item\.done\s*\|\|\s*item\.done/);
    });

    it('step 5: approve always — tool completes with block.decision=always', async () => {
        agent(['send', claudeSessionId!, 'Add a dark mode toggle to styles.css']);

        // Wait for permission
        await waitFor(async () => {
            const perms = agentJson<Array<{ id: string }>>(['permissions', claudeSessionId!]);
            return perms.length > 0;
        }, 120_000, 'permission request for dark mode');

        const perms = agentJson<Array<{ id: string }>>(['permissions', claudeSessionId!]);
        // Approve with allowTools to trigger "always" decision
        agent(['approve', claudeSessionId!, perms[0].id, '--allow-tools', 'Edit', 'Write']);

        agent(['wait', claudeSessionId!]);

        const toolParts = getV3ToolParts();
        const alwaysTool = toolParts.find(tp => {
            const state = tp.state as Record<string, unknown>;
            return (state.block as any)?.decision === 'always';
        });
        expect(alwaysTool).toBeTruthy();
    });

    it('step 6: auto-approved — no permission prompt, no block field', async () => {
        // Edit and Write are now auto-approved from step 5
        agent(['send', claudeSessionId!, 'Add a small comment to the top of styles.css saying "/* dark mode enabled */"', '--wait']);

        // Get the most recent tool parts after this send
        const asstMsgs = getV3AssistantMessages();
        const lastAsst = asstMsgs[asstMsgs.length - 1];
        const tools = lastAsst.parts.filter(p => p.type === 'tool');

        // Should have at least one tool
        expect(tools.length).toBeGreaterThan(0);

        // The tool should be completed with no block field (auto-approved)
        const autoApproved = tools.find(tp => {
            const state = tp.state as Record<string, unknown>;
            return state.status === 'completed' && !state.block;
        });
        expect(autoApproved).toBeTruthy();
    });

    // ── PERSISTENCE ─────────────────────────────────────────

    it('history has both v1 and v3 messages (dual write)', () => {
        const history = getHistory();
        const v3Count = history.filter(m => isV3Envelope(m.content)).length;
        const v1Count = history.filter(m => {
            const c = m.content as Record<string, unknown> | null;
            return c && (c.role === 'session' || c.role === 'user' || c.role === 'agent');
        }).length;

        expect(v3Count).toBeGreaterThan(5);
        expect(v1Count).toBeGreaterThan(0);
    });

    it('v3 messages contain correct structure', () => {
        const v3Msgs = getV3Messages();

        for (const msg of v3Msgs) {
            // Every message must have info with id, sessionID, role
            expect(msg.info).toBeDefined();
            expect((msg.info as any).id).toBeTruthy();
            expect((msg.info as any).sessionID).toBeTruthy();
            expect((msg.info as any).role).toMatch(/^(user|assistant)$/);

            // Every message must have parts array
            expect(Array.isArray(msg.parts)).toBe(true);
            expect(msg.parts.length).toBeGreaterThan(0);

            // Every part must have id, sessionID, messageID, type
            for (const part of msg.parts) {
                expect(part.id).toBeTruthy();
                expect(part.sessionID).toBeTruthy();
                expect(part.messageID).toBe((msg.info as any).id);
                expect(part.type).toBeTruthy();
            }
        }
    });

    it('permission decisions survive JSON round-trip', () => {
        const toolParts = getV3ToolParts();

        // Find tools with block decisions
        const withDecisions = toolParts.filter(tp => {
            const state = tp.state as Record<string, unknown>;
            return (state.block as any)?.decision != null;
        });

        expect(withDecisions.length).toBeGreaterThan(0);

        for (const tp of withDecisions) {
            const state = tp.state as Record<string, unknown>;
            const block = state.block as Record<string, unknown>;
            // Verify the block survived serialization
            expect(block.type).toBe('permission');
            expect(block.decision).toMatch(/^(once|always|reject)$/);
            expect(typeof block.decidedAt).toBe('number');
        }
    });
});
