/**
 * E2E Test Infrastructure
 *
 * Boots a real standalone happy-server (PGlite) and a real happy daemon.
 * The daemon spawns real CLI processes when sessions are created.
 *
 * Flow:
 *   1. Boot standalone server on a temp PGlite database
 *   2. Create auth token via /v1/auth
 *   3. Pre-seed daemon credentials (so it skips interactive auth)
 *   4. Boot the real daemon binary pointing at the test server
 *   5. Wait for daemon to be ready (writes state file with HTTP port)
 *
 * Tests then call `spawnSessionViaDaemon()` to trigger the daemon to spawn
 * a CLI process, which creates a session on the server. The test's SyncNode
 * sees the session and can send/receive messages.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';

// ─── Paths ───────────────────────────────────────────────────────────────────

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SERVER_DIR = join(REPO_ROOT, 'packages', 'happy-server');
const CLI_DIST_ENTRYPOINT = join(REPO_ROOT, 'packages', 'happy-cli', 'dist', 'index.mjs');
const MAX_CAPTURED_LOG_CHARS = 200_000;

// ─── Mutable state (set after boot) ─────────────────────────────────────────

let _serverUrl = '';
let _authToken = '';
let _daemonHttpPort = 0;
let _encryptionSecret: Uint8Array = new Uint8Array(0);

let serverProcess: ChildProcess | null = null;
let daemonProcess: ChildProcess | null = null;
let testDataDir: string | null = null;
let serverLog = '';
let daemonLog = '';

// ─── Exports ─────────────────────────────────────────────────────────────────

export function getServerUrl(): string { return _serverUrl; }
export function getAuthToken(): string { return _authToken; }
export function getDaemonHttpPort(): number { return _daemonHttpPort; }
export function getEncryptionSecret(): Uint8Array { return _encryptionSecret; }

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toBase64(value: Uint8Array): string {
    return Buffer.from(value).toString('base64');
}

function appendLogTail(existing: string, chunk: unknown): string {
    const next = existing + String(chunk);
    if (next.length <= MAX_CAPTURED_LOG_CHARS) {
        return next;
    }
    return next.slice(-MAX_CAPTURED_LOG_CHARS);
}

function runCommand(
    command: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', (chunk) => { output += String(chunk); });
        child.stderr.on('data', (chunk) => { output += String(chunk); });
        child.on('error', reject);
        child.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Command failed (${command} ${args.join(' ')}):\n${output}`));
        });
    });
}

async function waitForServerReady(url: string, timeoutMs = 30000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const response = await fetch(`${url}/v1/auth`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ publicKey: '', challenge: '', signature: '' }),
            });
            // Any response (even 401) means the server is up
            if (response.status >= 400) return;
        } catch {
            // Server not ready yet
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Server not ready at ${url} after ${timeoutMs}ms\n${serverLog}`);
}

async function createAuthToken(url: string): Promise<string> {
    const keyPair = nacl.sign.keyPair();
    const challenge = randomBytes(32);
    const signature = nacl.sign.detached(challenge, keyPair.secretKey);

    const response = await fetch(`${url}/v1/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            publicKey: toBase64(keyPair.publicKey),
            challenge: toBase64(challenge),
            signature: toBase64(signature),
        }),
    });

    if (!response.ok) {
        throw new Error(`Auth failed: ${response.status} ${await response.text()}\n${serverLog}`);
    }

    const data = (await response.json()) as { token?: string };
    if (!data.token) throw new Error('Auth endpoint did not return a token');
    return data.token;
}

// ─── Server boot ─────────────────────────────────────────────────────────────

async function startServer(port: string): Promise<void> {
    testDataDir = await mkdtemp(join(tmpdir(), 'happy-e2e-'));

    const env: NodeJS.ProcessEnv = {
        ...process.env,
        PORT: port,
        DATA_DIR: testDataDir,
        PGLITE_DIR: join(testDataDir, 'pglite'),
        METRICS_ENABLED: 'false',
        DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: '',
    };

    // Run migrations
    await runCommand('npx', ['tsx', '--env-file=.env.dev', './sources/standalone.ts', 'migrate'], SERVER_DIR, env);

    // Start server
    const child = spawn('npx', ['tsx', '--env-file=.env.dev', './sources/standalone.ts', 'serve'], {
        cwd: SERVER_DIR,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProcess = child;
    child.stdout?.on('data', (chunk) => { serverLog = appendLogTail(serverLog, chunk); });
    child.stderr?.on('data', (chunk) => { serverLog = appendLogTail(serverLog, chunk); });
    child.on('exit', (code, signal) => {
        if (code !== 0 || signal) {
            console.error(`[E2E SETUP] Server exited with code ${code}, signal ${signal}`);
            console.error(`[E2E SETUP] Server log:\n${serverLog}`);
        }
    });

    _serverUrl = `http://127.0.0.1:${port}`;
    await waitForServerReady(_serverUrl);
    _authToken = await createAuthToken(_serverUrl);
}

// ─── Daemon boot ─────────────────────────────────────────────────────────────

async function seedDaemonCredentials(homeDir: string): Promise<void> {
    await mkdir(homeDir, { recursive: true });
    await mkdir(join(homeDir, 'logs'), { recursive: true });

    // Generate a random 32-byte secret for legacy encryption
    _encryptionSecret = new Uint8Array(randomBytes(32));

    const credentialPayload = JSON.stringify({
        secret: toBase64(_encryptionSecret),
        token: _authToken,
    }, null, 2);

    // Write credentials files for both the daemon's normal auth flow
    // (`access.key`) and the historical-session resume flow (`agent.key`).
    await writeFile(
        join(homeDir, 'access.key'),
        credentialPayload,
    );
    await writeFile(
        join(homeDir, 'agent.key'),
        credentialPayload,
    );

    // Write settings file with machine ID
    await writeFile(
        join(homeDir, 'settings.json'),
        JSON.stringify({
            schemaVersion: 2,
            onboardingCompleted: true,
            machineId: randomUUID(),
            daemonAutoStartWhenRunningHappy: false,
        }, null, 2),
    );
}

/**
 * Create an isolated Claude config directory with 'default' permission mode.
 *
 * The Claude CLI reads ~/.claude/settings.json (or $CLAUDE_CONFIG_DIR/settings.json)
 * to determine its permission mode. If the real user has "defaultMode": "bypassPermissions",
 * the spawned CLI would auto-approve all tool calls and permission prompts would never appear.
 *
 * We copy only essential files from ~/.claude/ (auth, feature flags) and override
 * settings.json. Large dirs (projects/, debug/, telemetry/) are skipped.
 */
async function seedFakeClaudeConfig(targetDir: string): Promise<void> {
    await mkdir(targetDir, { recursive: true });

    const realClaudeDir = join(os.homedir(), '.claude');

    // Copy essential files — auth, feature flags, cache, backups
    // Skip large dirs: projects/ (889M), debug/ (779M), telemetry/ (188M)
    const essentialItems = [
        '.claude.json',        // OAuth credentials
        'statsig',             // Feature flag cache
        'cache',               // CLI cache
        'plugins',             // Plugins
        'history.jsonl',       // Conversation history index
    ];
    for (const name of essentialItems) {
        const src = join(realClaudeDir, name);
        if (existsSync(src)) {
            await cp(src, join(targetDir, name), { recursive: true }).catch(() => {});
        }
    }

    // Write clean settings that force 'default' permission mode
    await writeFile(
        join(targetDir, 'settings.json'),
        JSON.stringify({
            permissions: {
                defaultMode: 'default',
            },
        }, null, 2),
    );
}

async function startDaemon(): Promise<void> {
    if (!existsSync(CLI_DIST_ENTRYPOINT)) {
        throw new Error(
            `happy-cli build not found at ${CLI_DIST_ENTRYPOINT}.\n` +
            `Run 'yarn build' in packages/happy-cli before running e2e tests.`,
        );
    }

    const daemonHomeDir = join(testDataDir!, 'daemon-home');
    await seedDaemonCredentials(daemonHomeDir);

    const env: NodeJS.ProcessEnv = {
        ...process.env,
        HAPPY_SERVER_URL: _serverUrl,
        HAPPY_HOME_DIR: daemonHomeDir,
        HAPPY_DISABLE_CAFFEINATE: 'true',
        HAPPY_DAEMON_HEARTBEAT_INTERVAL: '600000', // 10 min — skip auto-update in tests
        HAPPY_VARIANT: 'dev',
        OPENCODE_PERMISSION: process.env.OPENCODE_PERMISSION ?? JSON.stringify({ edit: 'ask' }),
        DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: '',
        // E2E runs should not force verbose file logging by default; on low-disk
        // machines it can crash the isolated daemon with ENOSPC mid-walkthrough.
        DEBUG: process.env.HAPPY_E2E_DAEMON_DEBUG ?? '',
    };

    const child = spawn('node', ['--no-warnings', '--no-deprecation', CLI_DIST_ENTRYPOINT, 'daemon', 'start-sync'], {
        cwd: REPO_ROOT,  // so relative paths like "environments/lab-rat-todo-project" resolve correctly
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    daemonProcess = child;
    child.stdout?.on('data', (chunk) => { daemonLog = appendLogTail(daemonLog, chunk); });
    child.stderr?.on('data', (chunk) => { daemonLog = appendLogTail(daemonLog, chunk); });

    child.on('exit', (code, signal) => {
        if (code !== 0 && code !== null) {
            console.error(`[E2E SETUP] Daemon exited with code ${code}, signal ${signal}`);
            console.error(`[E2E SETUP] Daemon log:\n${daemonLog}`);
        }
    });

    // Wait for daemon to write state file
    const stateFile = join(daemonHomeDir, 'daemon.state.json');
    const start = Date.now();
    while (Date.now() - start < 30000) {
        try {
            const raw = await readFile(stateFile, 'utf-8');
            const state = JSON.parse(raw) as { httpPort?: number };
            if (state.httpPort) {
                _daemonHttpPort = state.httpPort;
                return;
            }
        } catch {
            // Not ready yet
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(
        `Daemon did not write state file within 30s.\n` +
        `State file: ${stateFile}\n` +
        `Daemon log:\n${daemonLog}`,
    );
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Boot the full e2e stack: standalone server + real daemon.
 * Call in `beforeAll` with a generous timeout (≥60s).
 */
export async function bootTestInfrastructure(): Promise<void> {
    const port = process.env.HAPPY_TEST_SERVER_PORT ?? '34106';
    await startServer(port);
    await startDaemon();
}

/**
 * Copy a repo fixture into the test temp directory so e2e runs do not mutate
 * the checked-in environment.
 */
export async function createIsolatedProjectCopy(relativePath: string): Promise<string> {
    if (!testDataDir) {
        throw new Error('Test infrastructure not booted — call bootTestInfrastructure() first');
    }

    const sourceDir = join(REPO_ROOT, relativePath);
    const targetDir = join(testDataDir, 'projects', `${relativePath.replace(/[\\/]/g, '-')}-${randomUUID()}`);
    await mkdir(join(targetDir, '..'), { recursive: true });
    await cp(sourceDir, targetDir, { recursive: true });
    return targetDir;
}

/**
 * Tear down the e2e stack. Call in `afterAll`.
 */
export async function teardownTestInfrastructure(): Promise<void> {
    if (daemonProcess && !daemonProcess.killed) {
        daemonProcess.kill('SIGTERM');
        await new Promise<void>((resolve) => {
            daemonProcess?.once('exit', () => resolve());
            setTimeout(resolve, 5000);
        });
    }

    if (serverProcess && !serverProcess.killed) {
        serverProcess.kill('SIGTERM');
        await new Promise<void>((resolve) => {
            serverProcess?.once('exit', () => resolve());
            setTimeout(resolve, 3000);
        });
    }

    if (testDataDir) {
        await rm(testDataDir, { recursive: true, force: true }).catch(() => {});
    }
}

/**
 * Ask the daemon to spawn a real CLI session.
 * Returns the session ID created by the CLI.
 */
export async function spawnSessionViaDaemon(opts: {
    directory: string;
    agent?: 'claude' | 'codex' | 'gemini' | 'opencode' | 'openclaw';
    sessionId?: string;
}): Promise<string> {
    if (!_daemonHttpPort) {
        throw new Error('Daemon not booted — call bootTestInfrastructure() first');
    }

    const response = await fetch(`http://127.0.0.1:${_daemonHttpPort}/spawn-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            directory: opts.directory,
            agent: opts.agent,
            sessionId: opts.sessionId,
        }),
    });

    const data = (await response.json()) as {
        success: boolean;
        sessionId?: string;
        error?: string;
    };

    if (!data.success || !data.sessionId) {
        throw new Error(
            `Failed to spawn session via daemon: ${data.error ?? 'unknown error'}\n` +
            `Daemon log (last 2000 chars):\n${daemonLog.slice(-2000)}`,
        );
    }

    return data.sessionId;
}

/**
 * Get daemon logs (useful for debugging test failures).
 */
export function getDaemonLog(): string { return daemonLog; }
export function getServerLog(): string { return serverLog; }

/**
 * Read all CLI log files from the daemon home directory.
 * These contain logger.debug output from spawned CLI processes (AcpBackend, etc.)
 */
export async function readCliLogs(): Promise<string> {
    if (!testDataDir) return '[no testDataDir]';
    const logsDir = join(testDataDir, 'daemon-home', 'logs');
    try {
        const { readdirSync } = await import('node:fs');
        const files = readdirSync(logsDir).filter(f => f.endsWith('.log')).sort();
        const logs: string[] = [];
        for (const file of files) {
            const content = await readFile(join(logsDir, file), 'utf-8');
            logs.push(`--- ${file} ---\n${content}`);
        }
        return logs.join('\n');
    } catch {
        return '[no logs found]';
    }
}
