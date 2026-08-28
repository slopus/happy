import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { io } from 'socket.io-client';
import { decodeBase64, decrypt, encodeBase64, encrypt, libsodiumEncryptForPublicKey } from './crypto/encryption';
import { resolveRecordEncryption, type RecordEncryption } from './crypto/records';
import type { PawsCredentials } from './client/types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(__dirname, '..');
const repoRoot = resolve(packageDir, '..', '..');
const environmentsDir = join(repoRoot, 'environments', 'data', 'envs');
const currentEnvironmentPath = join(repoRoot, 'environments', 'data', 'current.json');
const binPath = process.env.PAWS_AGENT_BIN_PATH
    ? resolve(process.env.PAWS_AGENT_BIN_PATH)
    : resolve(packageDir, 'bin', 'paws-agent.mjs');
const keepIntegrationEnv = ['1', 'true', 'yes'].includes((process.env.HAPPY_AGENT_KEEP_ENV ?? '').toLowerCase());

type PawsAgentClientConstructor = typeof import('./client/PawsAgentClient').PawsAgentClient;
type FileCredentialProviderConstructor = typeof import('./adapters/nodeCredentials').FileCredentialProvider;

async function loadSdkRuntime(): Promise<{
    PawsAgentClient: PawsAgentClientConstructor;
    FileCredentialProvider: FileCredentialProviderConstructor;
}> {
    const consumerDir = process.env.PAWS_AGENT_CONSUMER_DIR;
    if (!consumerDir) {
        const [root, node] = await Promise.all([
            import('./client/PawsAgentClient'),
            import('./adapters/nodeCredentials'),
        ]);
        return { PawsAgentClient: root.PawsAgentClient, FileCredentialProvider: node.FileCredentialProvider };
    }
    const resolveFromConsumer = createRequire(resolve(consumerDir, 'package.json')).resolve;
    const [root, node] = await Promise.all([
        import(pathToFileURL(resolveFromConsumer('@wangjs-jacky/paws-agent')).href),
        import(pathToFileURL(resolveFromConsumer('@wangjs-jacky/paws-agent/node')).href),
    ]);
    if (typeof root.PawsAgentClient !== 'function' || typeof node.FileCredentialProvider !== 'function') {
        throw new Error('Installed Paws Agent package does not expose the required integration runtime');
    }
    return {
        PawsAgentClient: root.PawsAgentClient as PawsAgentClientConstructor,
        FileCredentialProvider: node.FileCredentialProvider as FileCredentialProviderConstructor,
    };
}

const { PawsAgentClient, FileCredentialProvider } = await loadSdkRuntime();

type EnvironmentConfig = {
    name: string;
    serverPort: number;
    expoPort: number;
};

type DaemonState = {
    httpPort?: number;
    pid?: number;
};

type RawSessionRecord = {
    id: string;
    agentStateVersion: number;
    dataEncryptionKey: string | null;
};

let previousCurrentEnv: string | null = null;
let integrationEnvName: string | null = null;
let integrationEnvDir: string | null = null;
let integrationConfig: EnvironmentConfig | null = null;
let agentHomeDir: string | null = null;
let activeMachineId: string | null = null;
let testProjectDir: string | null = null;
let testWorktreeDir: string | null = null;
let previousAskBaseUrl: string | undefined;
let previousDeepSeekApiKey: string | undefined;
let fixtureServer: Server | null = null;
const spawnedSessionIds = new Set<string>();

async function runPnpmAsync(args: string[], cwd = repoRoot): Promise<string> {
    return await new Promise<string>((resolvePromise, rejectPromise) => {
        const child = spawn('pnpm', args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk.toString(); });
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.on('error', rejectPromise);
        child.on('close', code => {
            if (code === 0) {
                resolvePromise(stdout);
                return;
            }
            rejectPromise(new Error(`pnpm ${args.join(' ')} failed with code ${code}\n${stdout}\n${stderr}`));
        });
    });
}

function runCommand(command: string, args: string[], cwd = repoRoot, env: NodeJS.ProcessEnv = process.env): string {
    const result = spawnSync(command, args, {
        cwd,
        env,
        encoding: 'utf-8',
        maxBuffer: 20_000_000,
    });

    if (result.status !== 0) {
        const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
        throw new Error(`${command} ${args.join(' ')} failed with code ${result.status}\n${output}`);
    }

    return result.stdout;
}

function readCurrentEnvName(): string | null {
    if (!existsSync(currentEnvironmentPath)) {
        return null;
    }

    const parsed = JSON.parse(readFileSync(currentEnvironmentPath, 'utf-8')) as { current?: string };
    return parsed.current ?? null;
}

function environmentExists(name: string): boolean {
    return existsSync(join(environmentsDir, name, 'environment.json'));
}

function readEnvironmentConfig(envName: string): EnvironmentConfig {
    return JSON.parse(
        readFileSync(join(environmentsDir, envName, 'environment.json'), 'utf-8'),
    ) as EnvironmentConfig;
}

function readSeededCliCredentials(envDir: string): { token: string; secret: Uint8Array } {
    const credentialPath = join(envDir, 'cli', 'home', 'access.key');
    const parsed = JSON.parse(readFileSync(credentialPath, 'utf-8')) as { token: string; secret: string };
    return {
        token: parsed.token,
        secret: decodeBase64(parsed.secret),
    };
}

function readDaemonState(envDir: string): DaemonState | null {
    const daemonStatePath = join(envDir, 'cli', 'home', 'daemon.state.json');
    if (!existsSync(daemonStatePath)) {
        return null;
    }
    return JSON.parse(readFileSync(daemonStatePath, 'utf-8')) as DaemonState;
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function agentEnvVars(serverPort: number, homeDir: string): NodeJS.ProcessEnv {
    return {
        ...process.env,
        HAPPY_SERVER_URL: `http://localhost:${serverPort}`,
        HAPPY_HOME_DIR: homeDir,
    };
}

function runAgentCli(args: string[], env: NodeJS.ProcessEnv): string {
    return execFileSync(process.execPath, [
        '--no-warnings',
        '--no-deprecation',
        binPath,
        ...args,
    ], {
        env,
        encoding: 'utf-8',
        maxBuffer: 10_000_000,
    });
}

function writeFile(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf-8');
}

function createGitProject(envDir: string): { projectDir: string; worktreeDir: string } {
    const projectDir = join(envDir, 'paws-agent-test-project');
    const worktreeDir = join(projectDir, '.dev', 'worktree', 'feature-branch');

    mkdirSync(projectDir, { recursive: true });
    runCommand('git', ['init', '--initial-branch=main'], projectDir);
    runCommand('git', ['config', 'user.name', 'Paws Agent Test'], projectDir);
    runCommand('git', ['config', 'user.email', 'paws-agent-tests@example.com'], projectDir);

    writeFile(join(projectDir, 'README.md'), '# Paws Agent Test Project\n');
    writeFile(join(projectDir, 'src', 'index.ts'), 'export const answer = 42;\n');
    runCommand('git', ['add', '.'], projectDir);
    runCommand('git', ['commit', '-m', 'Initial commit'], projectDir);
    runCommand('git', ['worktree', 'add', '-b', 'feature-branch', worktreeDir], projectDir);

    return { projectDir, worktreeDir };
}

function parseJson<T>(value: string): T {
    return JSON.parse(value) as T;
}

function isUserTextMessage(message: unknown, expectedText: string): boolean {
    if (message == null || typeof message !== 'object' || Array.isArray(message)) {
        return false;
    }

    const payload = message as {
        role?: unknown;
        content?: {
            type?: unknown;
            text?: unknown;
        };
    };

    return payload.role === 'user'
        && payload.content?.type === 'text'
        && payload.content?.text === expectedText;
}

function containsText(value: unknown, expectedText: string): boolean {
    if (typeof value === 'string') return value.includes(expectedText);
    if (Array.isArray(value)) return value.some(item => containsText(item, expectedText));
    if (value == null || typeof value !== 'object') return false;
    return Object.values(value).some(item => containsText(item, expectedText));
}

async function startDeepSeekFixture(): Promise<string> {
    fixtureServer = createServer((_request, response) => {
        response.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        });
        setTimeout(() => {
            response.write('data: {"choices":[{"delta":{"content":"fixture "},"finish_reason":null}]}\n\n');
            setTimeout(() => {
                response.write('data: {"choices":[{"delta":{"content":"response"},"finish_reason":null}]}\n\n');
                response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
                response.end('data: [DONE]\n\n');
            }, 100);
        }, 750);
    });
    await new Promise<void>((resolvePromise, rejectPromise) => {
        fixtureServer!.once('error', rejectPromise);
        fixtureServer!.listen(0, '127.0.0.1', () => resolvePromise());
    });
    const address = fixtureServer.address();
    if (!address || typeof address === 'string') throw new Error('Fixture server did not bind a TCP port');
    return `http://127.0.0.1:${address.port}`;
}

async function waitForSessionInList(sessionId: string, env: NodeJS.ProcessEnv): Promise<void> {
    await waitFor(async () => {
        const sessions = parseJson<Array<{ id: string }>>(runAgentCli(['list', '--json'], env));
        return sessions.some(session => session.id === sessionId);
    }, 20_000, `session ${sessionId} to appear in paws-agent list`);
}

async function waitForHistoryMessage(sessionId: string, expectedText: string, env: NodeJS.ProcessEnv): Promise<void> {
    await waitFor(async () => {
        const history = parseJson<Array<{ content?: unknown }>>(runAgentCli(['history', sessionId, '--json'], env));
        return history.some(message => isUserTextMessage(message.content, expectedText));
    }, 20_000, `message "${expectedText}" in session ${sessionId} history`);
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (await check()) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(`Timed out waiting for ${label}`);
}

async function approveAgentLogin(
    serverUrl: string,
    token: string,
    secret: Uint8Array,
    publicKeyBase64: string,
): Promise<void> {
    const publicKey = decodeBase64(publicKeyBase64);
    const encryptedSecret = libsodiumEncryptForPublicKey(secret, publicKey);

    const response = await fetch(`${serverUrl}/v1/auth/account/response`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-Happy-Client': 'cli-control-plane/0.1.0',
        },
        body: JSON.stringify({
            publicKey: publicKeyBase64,
            response: encodeBase64(encryptedSecret),
        }),
    });

    if (!response.ok) {
        throw new Error(`Account auth approval failed: ${response.status} ${await response.text()}`);
    }
}

async function runAgentAuthLogin(env: NodeJS.ProcessEnv, approval: { serverUrl: string; token: string; secret: Uint8Array }): Promise<string> {
    return await new Promise<string>((resolvePromise, rejectPromise) => {
        const child = spawn(process.execPath, [
            '--no-warnings',
            '--no-deprecation',
            binPath,
            'auth',
            'login',
        ], {
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        let settled = false;
        let approvalStarted = false;

        const timeout = setTimeout(() => {
            if (settled) {
                return;
            }
            settled = true;
            child.kill('SIGKILL');
            rejectPromise(new Error(`Timed out waiting for paws-agent auth login.\n${stdout}\n${stderr}`));
        }, 60_000);

        const finish = (error?: Error, output?: string) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            if (error) {
                rejectPromise(error);
            } else {
                resolvePromise(output ?? stdout);
            }
        };

        const maybeApprove = () => {
            if (approvalStarted) {
                return;
            }
            const match = stdout.match(/- Public Key: `([^`]+)`/);
            if (!match) {
                return;
            }
            approvalStarted = true;

            void approveAgentLogin(approval.serverUrl, approval.token, approval.secret, match[1]).catch(error => {
                try {
                    child.kill('SIGTERM');
                } catch {
                    // ignore
                }
                finish(error instanceof Error ? error : new Error(String(error)));
            });
        };

        child.stdout.on('data', (chunk: Buffer | string) => {
            stdout += chunk.toString();
            maybeApprove();
        });

        child.stderr.on('data', (chunk: Buffer | string) => {
            stderr += chunk.toString();
        });

        child.on('error', error => {
            finish(error);
        });

        child.on('close', code => {
            if (code !== 0) {
                finish(new Error(`paws-agent auth login exited with code ${code}\n${stdout}\n${stderr}`));
                return;
            }
            finish(undefined, stdout);
        });
    });
}

async function listDaemonSessions(httpPort: number): Promise<Array<{ happySessionId: string; pid: number; startedBy: string }>> {
    const response = await fetch(`http://127.0.0.1:${httpPort}/list`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: '{}',
    });
    if (!response.ok) {
        throw new Error(`Daemon session list failed: ${response.status}`);
    }
    const parsed = await response.json() as { children: Array<{ happySessionId: string; pid: number; startedBy: string }> };
    return parsed.children;
}

async function stopDaemonSession(httpPort: number, sessionId: string): Promise<boolean> {
    const response = await fetch(`http://127.0.0.1:${httpPort}/stop-session`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sessionId }),
    });
    if (!response.ok) {
        return false;
    }
    const parsed = await response.json() as { success?: boolean };
    return parsed.success === true;
}

async function fetchRawSession(serverUrl: string, token: string, sessionId: string): Promise<RawSessionRecord> {
    const response = await fetch(`${serverUrl}/v1/sessions`, {
        headers: { Authorization: `Bearer ${token}`, 'X-Happy-Client': 'paws-agent-integration/0.1.0' },
    });
    if (!response.ok) throw new Error(`Session snapshot failed: ${response.status}`);
    const body = await response.json() as { sessions?: RawSessionRecord[] };
    const session = body.sessions?.find(candidate => candidate.id === sessionId);
    if (!session) throw new Error(`Raw session ${sessionId} not found`);
    return session;
}

async function writeAgentState(
    serverUrl: string,
    credentials: PawsCredentials,
    sessionId: string,
    encryption: RecordEncryption,
    state: unknown,
): Promise<void> {
    const raw = await fetchRawSession(serverUrl, credentials.token, sessionId);
    const socket = io(serverUrl, {
        auth: { token: credentials.token, clientType: 'user-scoped', happyClient: 'paws-agent-integration/0.1.0' },
        path: '/v1/updates',
        transports: ['websocket'],
    });
    try {
        await new Promise<void>((resolvePromise, rejectPromise) => {
            socket.once('connect', () => resolvePromise());
            socket.once('connect_error', rejectPromise);
        });
        const result = await socket.timeout(5_000).emitWithAck('update-state', {
            sid: sessionId,
            expectedVersion: raw.agentStateVersion,
            agentState: encodeBase64(encrypt(encryption.key, encryption.variant, state)),
        }) as { result?: string };
        if (result.result !== 'success') throw new Error(`Fixture state update failed: ${JSON.stringify(result)}`);
    } finally {
        socket.close();
    }
}

describe('paws-agent integration', { timeout: 180_000 }, () => {
    beforeAll(async () => {
        previousCurrentEnv = readCurrentEnvName();
        previousAskBaseUrl = process.env.HAPPY_ASK_BASE_URL;
        previousDeepSeekApiKey = process.env.HAPPY_DEEPSEEK_API_KEY;
        process.env.HAPPY_ASK_BASE_URL = await startDeepSeekFixture();
        process.env.HAPPY_DEEPSEEK_API_KEY = 'paws-agent-fixture-key';

        try {
            await runPnpmAsync(['env:up', '--template', 'authenticated-empty', '--no-web']);
        } finally {
            const current = readCurrentEnvName();
            if (current && current !== previousCurrentEnv) {
                integrationEnvName = current;
                integrationEnvDir = join(environmentsDir, current);
            }
        }

        if (!integrationEnvName || !integrationEnvDir) {
            throw new Error('Failed to determine integration environment name');
        }

        const envName = integrationEnvName;
        const envDir = integrationEnvDir;
        integrationConfig = readEnvironmentConfig(envName);
        agentHomeDir = join(envDir, 'cli', 'home');

        const testProject = createGitProject(envDir);
        testProjectDir = testProject.projectDir;
        testWorktreeDir = testProject.worktreeDir;

        if (keepIntegrationEnv) {
            console.log(`[paws-agent integration] keeping environment: ${integrationEnvName}`);
            console.log(`[paws-agent integration] environment dir: ${integrationEnvDir}`);
        }
    });

    afterAll(async () => {
        if (previousAskBaseUrl === undefined) {
            delete process.env.HAPPY_ASK_BASE_URL;
        } else {
            process.env.HAPPY_ASK_BASE_URL = previousAskBaseUrl;
        }
        if (previousDeepSeekApiKey === undefined) {
            delete process.env.HAPPY_DEEPSEEK_API_KEY;
        } else {
            process.env.HAPPY_DEEPSEEK_API_KEY = previousDeepSeekApiKey;
        }
        if (fixtureServer) {
            fixtureServer.closeAllConnections();
            await new Promise<void>(resolvePromise => fixtureServer!.close(() => resolvePromise()));
            fixtureServer = null;
        }
        if (keepIntegrationEnv) {
            return;
        }

        try {
            if (integrationEnvDir) {
                const daemonState = readDaemonState(integrationEnvDir);
                if (daemonState?.httpPort) {
                    for (const sessionId of spawnedSessionIds) {
                        await stopDaemonSession(daemonState.httpPort, sessionId).catch(() => false);
                    }
                }
            }
        } finally {
            if (integrationEnvName) {
                try {
                    await runPnpmAsync(['env:down']);
                } catch {
                    // ignore cleanup failures here and continue best effort
                }

                try {
                    await runPnpmAsync(['env:remove', integrationEnvName]);
                } catch {
                    // ignore cleanup failures here and continue best effort
                }
            }

            if (
                previousCurrentEnv
                && previousCurrentEnv !== integrationEnvName
                && environmentExists(previousCurrentEnv)
            ) {
                try {
                    await runPnpmAsync(['env:use', previousCurrentEnv]);
                } catch {
                    // ignore restore failures
                }
            }
        }
    });

    it('authenticates, lists machines, and spawns a session through the real daemon RPC path', async () => {
        if (!integrationEnvDir || !integrationConfig || !agentHomeDir || !testProjectDir || !testWorktreeDir) {
            throw new Error('Integration environment not initialized');
        }

        const serverUrl = `http://localhost:${integrationConfig.serverPort}`;
        const seededCredentials = readSeededCliCredentials(integrationEnvDir);
        const agentEnv = agentEnvVars(integrationConfig.serverPort, agentHomeDir);

        const authOutput = await runAgentAuthLogin(agentEnv, {
            serverUrl,
            token: seededCredentials.token,
            secret: seededCredentials.secret,
        });

        expect(authOutput).toContain('- Status: Authenticated');
        expect(existsSync(join(agentHomeDir, 'agent.key'))).toBe(true);

        const machineOutput = runAgentCli(['machines'], agentEnv);
        expect(machineOutput).toContain('## Machines');

        const machines = JSON.parse(runAgentCli(['machines', '--json'], agentEnv)) as Array<{
            id: string;
            active: boolean;
            metadata?: {
                homeDir?: string;
                resumeSupport?: {
                    rpcAvailable?: boolean;
                    happyAgentAuthenticated?: boolean;
                };
            };
        }>;
        expect(machines.length).toBeGreaterThan(0);

        const machine = machines.find(item => item.active) ?? machines[0];
        expect(machine.id).toBeTruthy();
        activeMachineId = machine.id;

        await waitFor(async () => {
            const refreshedMachines = JSON.parse(runAgentCli(['machines', '--json'], agentEnv)) as Array<{
                id: string;
                metadata?: {
                    resumeSupport?: {
                        rpcAvailable?: boolean;
                        happyAgentAuthenticated?: boolean;
                    };
                };
            }>;
            const refreshedMachine = refreshedMachines.find(item => item.id === machine.id);
            return refreshedMachine?.metadata?.resumeSupport?.rpcAvailable === true
                && refreshedMachine.metadata.resumeSupport.happyAgentAuthenticated === true;
        }, 20_000, `machine ${machine.id} to advertise resume RPC support`);

        const spawnResult = JSON.parse(
            runAgentCli([
                'spawn',
                '--machine',
                machine.id,
                '--path',
                testProjectDir,
                '--agent',
                'ask',
                '--json',
            ], agentEnv),
        ) as {
            type: string;
            sessionId?: string;
            machineId?: string;
            directory?: string;
        };

        expect(spawnResult.type).toBe('success');
        expect(spawnResult.sessionId).toBeTruthy();
        expect(spawnResult.machineId).toBe(machine.id);
        expect(spawnResult.directory).toBe(testProjectDir);

        const sessionId = spawnResult.sessionId!;
        spawnedSessionIds.add(sessionId);

        await waitForSessionInList(sessionId, agentEnv);

        const status = JSON.parse(
            runAgentCli(['status', sessionId, '--json'], agentEnv),
        ) as {
            id: string;
            metadata?: { path?: string; flavor?: string };
        };

        expect(status.id).toBe(sessionId);
        expect(status.metadata?.path).toBe(testProjectDir);
        expect(status.metadata?.flavor).toBe('ask');

        const daemonState = readDaemonState(integrationEnvDir);
        expect(daemonState?.httpPort).toBeTruthy();

        await waitFor(async () => {
            const sessions = await listDaemonSessions(daemonState!.httpPort!);
            return sessions.some(session => session.happySessionId === sessionId);
        }, 20_000, 'spawned session to be tracked by daemon');
    });

    it('spawns in the test project root and sends a message through paws-agent CLI', async () => {
        if (!activeMachineId || !integrationConfig || !agentHomeDir || !testProjectDir) {
            throw new Error('Integration environment not initialized');
        }

        const agentEnv = agentEnvVars(integrationConfig.serverPort, agentHomeDir);
        const prompt = 'paws-agent root message';
        const spawnResult = parseJson<{
            type: 'success' | 'requestToApproveDirectoryCreation' | 'error';
            sessionId?: string;
            machineId?: string;
            directory?: string;
        }>(
            runAgentCli([
                'spawn',
                '--machine',
                activeMachineId,
                '--path',
                testProjectDir,
                '--agent',
                'ask',
                '--json',
            ], agentEnv),
        );

        expect(spawnResult.type).toBe('success');
        expect(spawnResult.directory).toBe(testProjectDir);

        const sessionId = spawnResult.sessionId!;
        spawnedSessionIds.add(sessionId);

        await waitForSessionInList(sessionId, agentEnv);

        const status = parseJson<{
            id: string;
            metadata?: { path?: string };
        }>(runAgentCli(['status', sessionId, '--json'], agentEnv));
        expect(status.id).toBe(sessionId);
        expect(status.metadata?.path).toBe(testProjectDir);

        const sendResult = parseJson<{ sessionId: string; localId: string }>(
            runAgentCli(['send', sessionId, prompt, '--json'], agentEnv),
        );
        expect(sendResult.sessionId).toBe(sessionId);
        expect(sendResult.localId).toBeTruthy();

        await waitForHistoryMessage(sessionId, prompt, agentEnv);
    });

    it('spawns in a git worktree and sends a message through paws-agent CLI', async () => {
        if (!activeMachineId || !integrationConfig || !agentHomeDir || !testWorktreeDir) {
            throw new Error('Integration environment not initialized');
        }

        const agentEnv = agentEnvVars(integrationConfig.serverPort, agentHomeDir);
        const prompt = 'paws-agent worktree message';
        const spawnResult = parseJson<{
            type: 'success' | 'requestToApproveDirectoryCreation' | 'error';
            sessionId?: string;
            machineId?: string;
            directory?: string;
        }>(
            runAgentCli([
                'spawn',
                '--machine',
                activeMachineId,
                '--path',
                testWorktreeDir,
                '--agent',
                'ask',
                '--json',
            ], agentEnv),
        );

        expect(spawnResult.type).toBe('success');
        expect(spawnResult.directory).toBe(testWorktreeDir);

        const sessionId = spawnResult.sessionId!;
        spawnedSessionIds.add(sessionId);

        await waitForSessionInList(sessionId, agentEnv);

        const status = parseJson<{
            id: string;
            metadata?: { path?: string };
        }>(runAgentCli(['status', sessionId, '--json'], agentEnv));
        expect(status.id).toBe(sessionId);
        expect(status.metadata?.path).toBe(testWorktreeDir);

        const sendResult = parseJson<{ sessionId: string; localId: string }>(
            runAgentCli(['send', sessionId, prompt, '--json'], agentEnv),
        );
        expect(sendResult.sessionId).toBe(sessionId);
        expect(sendResult.localId).toBeTruthy();

        await waitForHistoryMessage(sessionId, prompt, agentEnv);
    });

    it('handles directory approval through the SDK and real machine RPC', async () => {
        if (!activeMachineId || !integrationConfig || !agentHomeDir || !integrationEnvDir) {
            throw new Error('Integration environment not initialized');
        }
        const deniedDirectory = join(integrationEnvDir, 'denied-new-directory');
        const directory = join(integrationEnvDir, 'approved-new-directory');
        const client = new PawsAgentClient({
            serverUrl: `http://localhost:${integrationConfig.serverPort}`,
            credentials: new FileCredentialProvider(join(agentHomeDir, 'agent.key')),
        });
        await client.connect();
        try {
            const denied = await client.sessions.spawn({
                machineId: activeMachineId,
                directory: deniedDirectory,
                agent: 'ask',
            });
            expect(denied).toEqual({ type: 'requestToApproveDirectoryCreation', directory: deniedDirectory });
            expect(existsSync(deniedDirectory)).toBe(false);

            const pending = await client.sessions.spawn({
                machineId: activeMachineId,
                directory,
                agent: 'ask',
            });
            expect(pending).toEqual({ type: 'requestToApproveDirectoryCreation', directory });

            const approved = await client.sessions.spawn({
                machineId: activeMachineId,
                directory,
                agent: 'ask',
                approvedNewDirectoryCreation: true,
            });
            expect(approved.type).toBe('success');
            if (approved.type === 'success') spawnedSessionIds.add(approved.sessionId);
        } finally {
            await client.dispose();
        }
    });

    it('observes the deterministic fixture turn lifecycle and response', async () => {
        if (!activeMachineId || !integrationConfig || !agentHomeDir || !testProjectDir) {
            throw new Error('Integration environment not initialized');
        }
        const client = new PawsAgentClient({
            serverUrl: `http://localhost:${integrationConfig.serverPort}`,
            credentials: new FileCredentialProvider(join(agentHomeDir, 'agent.key')),
        });
        await client.connect();
        try {
            const spawned = await client.sessions.spawn({
                machineId: activeMachineId,
                directory: testProjectDir,
                agent: 'ask',
            });
            expect(spawned.type).toBe('success');
            if (spawned.type !== 'success') throw new Error('Expected fixture session to spawn');
            spawnedSessionIds.add(spawned.sessionId);

            await client.messages.send({ sessionId: spawned.sessionId, text: 'fixture lifecycle' });
            await waitFor(async () => {
                const state = (await client.sessions.get(spawned.sessionId)).agentState as {
                    turnStatus?: { status?: string };
                } | null;
                return state?.turnStatus?.status === 'running';
            }, 20_000, 'fixture session to become busy');
            await waitFor(async () => {
                const state = (await client.sessions.get(spawned.sessionId)).agentState as {
                    turnStatus?: { status?: string };
                } | null;
                return state?.turnStatus?.status === 'completed';
            }, 20_000, 'fixture session to become idle');
            await waitFor(async () => {
                const history = await client.messages.history(spawned.sessionId);
                return history.some(message => containsText(message.content, 'fixture response'));
            }, 20_000, 'fixture response in session history');
        } finally {
            await client.dispose();
        }
    });

    it('deduplicates sends, resyncs after reconnect, and rejects sends after archive', async () => {
        if (!activeMachineId || !integrationConfig || !agentHomeDir || !testProjectDir) {
            throw new Error('Integration environment not initialized');
        }
        const agentEnv = agentEnvVars(integrationConfig.serverPort, agentHomeDir);
        const client = new PawsAgentClient({
            serverUrl: `http://localhost:${integrationConfig.serverPort}`,
            credentials: new FileCredentialProvider(join(agentHomeDir, 'agent.key')),
        });
        const states: string[] = [];
        client.subscribe(event => {
            if (event.type === 'connection') states.push(event.state);
        });
        await client.connect();
        const spawned = await client.sessions.spawn({
            machineId: activeMachineId,
            directory: testProjectDir,
            agent: 'ask',
        });
        expect(spawned.type).toBe('success');
        if (spawned.type !== 'success') throw new Error('Expected fixture session to spawn');
        const sessionId = spawned.sessionId;
        spawnedSessionIds.add(sessionId);
        await waitForSessionInList(sessionId, agentEnv);
        const prompt = 'paws-agent idempotency message';
        const localId = 'integration-local-id';
        await client.messages.send({ sessionId, text: prompt, localId });
        await client.messages.send({ sessionId, text: prompt, localId });
        await waitForHistoryMessage(sessionId, prompt, agentEnv);
        const history = await client.messages.history(sessionId);
        expect(history.filter(message => message.localId === localId)).toHaveLength(1);

        const secondClient = new PawsAgentClient({
            serverUrl: `http://localhost:${integrationConfig.serverPort}`,
            credentials: new FileCredentialProvider(join(agentHomeDir, 'agent.key')),
        });
        try {
            await secondClient.messages.send({ sessionId, text: 'second client update' });
            await waitFor(async () => {
                const messages = await client.messages.history(sessionId);
                return messages.some(message => isUserTextMessage(message.content, 'second client update'));
            }, 20_000, 'second client message to become visible');
        } finally {
            await secondClient.dispose();
        }

        await client.disconnect();
        await client.connect();
        expect((await client.sessions.get(sessionId)).id).toBe(sessionId);
        expect(states.filter(state => state === 'ready')).toHaveLength(2);

        await client.sessions.stop(sessionId);
        await waitFor(async () => !(await client.sessions.get(sessionId)).active, 20_000, 'session to archive');
        await expect(client.messages.send({ sessionId, text: 'too late' }))
            .rejects.toMatchObject({ code: 'SESSION_ARCHIVED' });
        await expect(client.requests.approve({ sessionId, requestId: 'missing-request' }))
            .rejects.toMatchObject({ code: 'NOT_FOUND' });
        await client.dispose();
    });

    it('resolves a real approval RPC and normalizes a full-stack RPC timeout', async () => {
        if (!activeMachineId || !integrationConfig || !agentHomeDir || !testProjectDir) {
            throw new Error('Integration environment not initialized');
        }
        const serverUrl = `http://localhost:${integrationConfig.serverPort}`;
        const provider = new FileCredentialProvider(join(agentHomeDir, 'agent.key'));
        const credentials = await provider.getCredentials();
        if (!credentials) throw new Error('Expected fixture credentials');
        const client = new PawsAgentClient({ serverUrl, credentials: provider });
        await client.connect();
        const spawned = await client.sessions.spawn({
            machineId: activeMachineId,
            directory: testProjectDir,
            agent: 'ask',
        });
        expect(spawned.type).toBe('success');
        if (spawned.type !== 'success') throw new Error('Expected fixture session to spawn');
        spawnedSessionIds.add(spawned.sessionId);

        const raw = await fetchRawSession(serverUrl, credentials.token, spawned.sessionId);
        const encryption = resolveRecordEncryption(raw, credentials, 'session');
        const fixtureSocket = io(serverUrl, {
            auth: {
                token: credentials.token,
                clientType: 'session-scoped',
                sessionId: spawned.sessionId,
                happyClient: 'paws-agent-integration-fixture/0.1.0',
            },
            path: '/v1/updates',
            transports: ['websocket'],
        });
        let acknowledge = true;
        let receivedApproval: unknown;
        fixtureSocket.on('rpc-request', (request: { method?: string; params?: string }, callback: (result: string) => void) => {
            if (request.method !== `${spawned.sessionId}:permission` || typeof request.params !== 'string') return;
            receivedApproval = decrypt(encryption.key, encryption.variant, decodeBase64(request.params));
            if (acknowledge) {
                callback(encodeBase64(encrypt(encryption.key, encryption.variant, { accepted: true })));
            }
        });
        try {
            await new Promise<void>((resolvePromise, rejectPromise) => {
                fixtureSocket.once('connect', () => resolvePromise());
                fixtureSocket.once('connect_error', rejectPromise);
            });
            await new Promise<void>((resolvePromise, rejectPromise) => {
                const timeout = setTimeout(() => rejectPromise(new Error('RPC fixture registration timed out')), 5_000);
                fixtureSocket.once('rpc-registered', (event: { method?: string }) => {
                    if (event.method !== `${spawned.sessionId}:permission`) return;
                    clearTimeout(timeout);
                    resolvePromise();
                });
                fixtureSocket.emit('rpc-register', { method: `${spawned.sessionId}:permission` });
            });

            await writeAgentState(serverUrl, credentials, spawned.sessionId, encryption, {
                controlledByUser: true,
                requests: { 'fixture-approval': { tool: 'Bash', arguments: { command: 'pwd' } } },
            });
            await waitFor(async () => {
                const state = (await client.sessions.get(spawned.sessionId)).agentState as { requests?: Record<string, unknown> } | null;
                return state?.requests?.['fixture-approval'] != null;
            }, 10_000, 'fixture approval request');
            await client.requests.approve({ sessionId: spawned.sessionId, requestId: 'fixture-approval' });
            expect(receivedApproval).toEqual({ id: 'fixture-approval', approved: true });

            acknowledge = false;
            await writeAgentState(serverUrl, credentials, spawned.sessionId, encryption, {
                controlledByUser: true,
                requests: { 'fixture-timeout': { tool: 'Bash', arguments: { command: 'pwd' } } },
            });
            await waitFor(async () => {
                const state = (await client.sessions.get(spawned.sessionId)).agentState as { requests?: Record<string, unknown> } | null;
                return state?.requests?.['fixture-timeout'] != null;
            }, 10_000, 'fixture timeout request');
            await expect(client.requests.approve({ sessionId: spawned.sessionId, requestId: 'fixture-timeout' }))
                .rejects.toMatchObject({ code: 'RPC_TIMEOUT' });
        } finally {
            fixtureSocket.close();
            await client.dispose();
        }
    });

    it('normalizes expired credentials against the isolated server', async () => {
        if (!integrationConfig || !agentHomeDir) throw new Error('Integration environment not initialized');
        const validProvider = new FileCredentialProvider(join(agentHomeDir, 'agent.key'));
        const valid = await validProvider.getCredentials();
        if (!valid) throw new Error('Expected fixture credentials');
        const client = new PawsAgentClient({
            serverUrl: `http://localhost:${integrationConfig.serverPort}`,
            credentials: {
                getCredentials: async () => ({ ...valid, token: 'expired-fixture-token' }),
                setCredentials: async () => undefined,
                clearCredentials: async () => undefined,
            },
        });
        try {
            await expect(client.machines.list()).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
        } finally {
            await client.dispose();
        }
    });

    it('reports the isolated machine offline after its daemon exits', async () => {
        if (!activeMachineId || !integrationConfig || !agentHomeDir || !integrationEnvDir || !testProjectDir) {
            throw new Error('Integration environment not initialized');
        }
        const daemonState = readDaemonState(integrationEnvDir);
        if (!daemonState?.pid || !daemonState.httpPort) throw new Error('Isolated daemon state is unavailable');

        for (const child of await listDaemonSessions(daemonState.httpPort)) {
            await stopDaemonSession(daemonState.httpPort, child.happySessionId);
        }
        await waitFor(async () => (await listDaemonSessions(daemonState.httpPort!)).length === 0, 20_000, 'isolated daemon sessions to stop');

        const client = new PawsAgentClient({
            serverUrl: `http://localhost:${integrationConfig.serverPort}`,
            credentials: new FileCredentialProvider(join(agentHomeDir, 'agent.key')),
        });
        await client.connect();
        await client.machines.list();
        process.kill(daemonState.pid, 'SIGTERM');
        await waitFor(async () => !isProcessAlive(daemonState.pid!), 20_000, 'isolated daemon to exit');
        try {
            await expect(client.sessions.spawn({
                machineId: activeMachineId,
                directory: testProjectDir,
                agent: 'ask',
            })).rejects.toMatchObject({ code: 'MACHINE_OFFLINE' });
        } finally {
            await client.dispose();
        }
    });
});
