import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeBase64, encodeBase64, libsodiumEncryptForPublicKey } from './encryption';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(__dirname, '..');
const repoRoot = resolve(packageDir, '..', '..');
const environmentsDir = join(repoRoot, 'environments', 'data', 'envs');
const currentEnvironmentPath = join(repoRoot, 'environments', 'data', 'current.json');
const binPath = resolve(packageDir, 'bin', 'happy-agent.mjs');
const keepIntegrationEnv = ['1', 'true', 'yes'].includes((process.env.HAPPY_AGENT_KEEP_ENV ?? '').toLowerCase());

type EnvironmentConfig = {
    name: string;
    serverPort: number;
    expoPort: number;
};

type DaemonState = {
    httpPort?: number;
    pid?: number;
};

let previousCurrentEnv: string | null = null;
let integrationEnvName: string | null = null;
let integrationEnvDir: string | null = null;
let integrationConfig: EnvironmentConfig | null = null;
let agentHomeDir: string | null = null;
let activeMachineId: string | null = null;
let testProjectDir: string | null = null;
let testWorktreeDir: string | null = null;
const spawnedSessionIds = new Set<string>();

function runYarn(args: string[], cwd = repoRoot): string {
    return runCommand('yarn', args, cwd, process.env);
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
    const projectDir = join(envDir, 'happy-agent-test-project');
    const worktreeDir = join(projectDir, '.dev', 'worktree', 'feature-branch');

    mkdirSync(projectDir, { recursive: true });
    runCommand('git', ['init', '--initial-branch=main'], projectDir);
    runCommand('git', ['config', 'user.name', 'Happy Agent Test'], projectDir);
    runCommand('git', ['config', 'user.email', 'happy-agent-tests@example.com'], projectDir);

    writeFile(join(projectDir, 'README.md'), '# Happy Agent Test Project\n');
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

async function waitForSessionInList(sessionId: string, env: NodeJS.ProcessEnv): Promise<void> {
    await waitFor(async () => {
        const sessions = parseJson<Array<{ id: string }>>(runAgentCli(['list', '--json'], env));
        return sessions.some(session => session.id === sessionId);
    }, 20_000, `session ${sessionId} to appear in happy-agent list`);
}

async function waitForHistoryMessage(sessionId: string, expectedText: string, env: NodeJS.ProcessEnv): Promise<void> {
    await waitFor(async () => {
        const history = parseJson<Array<{ content?: unknown }>>(runAgentCli(['history', sessionId, '--json'], env));
        return history.some(message => isUserTextMessage(message.content, expectedText));
    }, 20_000, `message "${expectedText}" in session ${sessionId} history`);
}

async function waitForSessionStatus<T>(
    sessionId: string,
    env: NodeJS.ProcessEnv,
    predicate: (status: T) => boolean,
    label: string,
): Promise<T> {
    let lastStatus: T | null = null;
    await waitFor(async () => {
        lastStatus = parseJson<T>(runAgentCli(['status', sessionId, '--json'], env));
        return predicate(lastStatus);
    }, 20_000, label);
    return lastStatus as T;
}

async function waitForFile(path: string): Promise<void> {
    await waitFor(async () => existsSync(path), 60_000, `file ${path}`);
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
            rejectPromise(new Error(`Timed out waiting for happy-agent auth login.\n${stdout}\n${stderr}`));
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
                finish(new Error(`happy-agent auth login exited with code ${code}\n${stdout}\n${stderr}`));
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

describe('happy-agent integration', { timeout: 180_000 }, () => {
    beforeAll(async () => {
        previousCurrentEnv = readCurrentEnvName();

        runYarn(['env:up:authenticated']);

        integrationEnvName = readCurrentEnvName();
        if (!integrationEnvName) {
            throw new Error('Failed to determine integration environment name');
        }

        integrationEnvDir = join(environmentsDir, integrationEnvName);
        integrationConfig = readEnvironmentConfig(integrationEnvName);
        agentHomeDir = join(integrationEnvDir, 'cli', 'home');

        const testProject = createGitProject(integrationEnvDir);
        testProjectDir = testProject.projectDir;
        testWorktreeDir = testProject.worktreeDir;

        if (keepIntegrationEnv) {
            console.log(`[happy-agent integration] keeping environment: ${integrationEnvName}`);
            console.log(`[happy-agent integration] environment dir: ${integrationEnvDir}`);
        }
    });

    afterAll(async () => {
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
                    runYarn(['env:down']);
                } catch {
                    // ignore cleanup failures here and continue best effort
                }

                try {
                    runYarn(['env:remove', integrationEnvName]);
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
                    runYarn(['env:use', previousCurrentEnv]);
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
        expect(status.metadata?.flavor).toBe('claude');

        const daemonState = readDaemonState(integrationEnvDir);
        expect(daemonState?.httpPort).toBeTruthy();

        await waitFor(async () => {
            const sessions = await listDaemonSessions(daemonState!.httpPort!);
            return sessions.some(session => session.happySessionId === sessionId);
        }, 20_000, 'spawned session to be tracked by daemon');
    });

    it('spawns in the test project root and sends a message through happy-agent CLI', async () => {
        if (!activeMachineId || !integrationConfig || !agentHomeDir || !testProjectDir) {
            throw new Error('Integration environment not initialized');
        }

        const agentEnv = agentEnvVars(integrationConfig.serverPort, agentHomeDir);
        const prompt = 'happy-agent root message';
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

        const sendResult = parseJson<{ sessionId: string; message: string; sent: boolean; permissionMode: string | null }>(
            runAgentCli(['send', sessionId, prompt, '--json'], agentEnv),
        );
        expect(sendResult).toEqual({
            sessionId,
            message: prompt,
            sent: true,
            permissionMode: null,
        });

        await waitForHistoryMessage(sessionId, prompt, agentEnv);
    });

    it('spawns in a git worktree and sends a message through happy-agent CLI', async () => {
        if (!activeMachineId || !integrationConfig || !agentHomeDir || !testWorktreeDir) {
            throw new Error('Integration environment not initialized');
        }

        const agentEnv = agentEnvVars(integrationConfig.serverPort, agentHomeDir);
        const prompt = 'happy-agent worktree message';
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

        const sendResult = parseJson<{ sessionId: string; message: string; sent: boolean; permissionMode: string | null }>(
            runAgentCli(['send', sessionId, prompt, '--json'], agentEnv),
        );
        expect(sendResult).toEqual({
            sessionId,
            message: prompt,
            sent: true,
            permissionMode: null,
        });

        await waitForHistoryMessage(sessionId, prompt, agentEnv);
    });

    it('resumes an existing Codex session through the same daemon RPC used by the app', async () => {
        if (!activeMachineId || !integrationConfig || !agentHomeDir || !testProjectDir) {
            throw new Error('Integration environment not initialized');
        }

        const agentEnv = agentEnvVars(integrationConfig.serverPort, agentHomeDir);
        const prompt = 'Reply with exactly: codex resume ready';
        const spawnResult = parseJson<{
            type: 'success' | 'requestToApproveDirectoryCreation' | 'error';
            sessionId?: string;
            machineId?: string;
            directory?: string;
            agent?: string | null;
        }>(
            runAgentCli([
                'spawn',
                '--machine',
                activeMachineId,
                '--path',
                testProjectDir,
                '--agent',
                'codex',
                '--json',
            ], agentEnv),
        );

        expect(spawnResult.type).toBe('success');
        expect(spawnResult.directory).toBe(testProjectDir);
        expect(spawnResult.agent).toBe('codex');

        const sourceSessionId = spawnResult.sessionId!;
        spawnedSessionIds.add(sourceSessionId);
        await waitForSessionInList(sourceSessionId, agentEnv);

        const sendResult = parseJson<{ sessionId: string; message: string; sent: boolean; permissionMode: string | null }>(
            runAgentCli(['send', sourceSessionId, prompt, '--wait', '--json'], agentEnv),
        );
        expect(sendResult).toEqual({
            sessionId: sourceSessionId,
            message: prompt,
            sent: true,
            permissionMode: null,
        });
        await waitForHistoryMessage(sourceSessionId, prompt, agentEnv);

        const sourceStatus = await waitForSessionStatus<{
            id: string;
            metadata?: { path?: string; flavor?: string; claudeSessionId?: string; codexThreadId?: string };
        }>(
            sourceSessionId,
            agentEnv,
            (status) => Boolean(status.metadata?.codexThreadId),
            `session ${sourceSessionId} to expose a resumable backend identifier`,
        );

        expect(sourceStatus.id).toBe(sourceSessionId);
        expect(sourceStatus.metadata?.path).toBe(testProjectDir);
        expect(sourceStatus.metadata?.flavor).toBe('codex');

        const resumeResult = parseJson<{
            type: 'success' | 'requestToApproveDirectoryCreation' | 'error';
            sessionId?: string;
            sourceSessionId?: string;
            machineId?: string;
        }>(
            runAgentCli(['resume', sourceSessionId, '--json'], agentEnv),
        );

        expect(resumeResult.type).toBe('success');
        expect(resumeResult.sourceSessionId).toBe(sourceSessionId);
        expect(resumeResult.machineId).toBe(activeMachineId);
        expect(resumeResult.sessionId).toBeTruthy();
        expect(resumeResult.sessionId).not.toBe(sourceSessionId);

        const resumedSessionId = resumeResult.sessionId!;
        spawnedSessionIds.add(resumedSessionId);
        await waitForSessionInList(resumedSessionId, agentEnv);

        const resumedStatus = await waitForSessionStatus<{
            id: string;
            metadata?: { path?: string; flavor?: string };
        }>(
            resumedSessionId,
            agentEnv,
            (status) => status.metadata?.path === testProjectDir,
            `resumed session ${resumedSessionId} to report the original path`,
        );

        expect(resumedStatus.id).toBe(resumedSessionId);
        expect(resumedStatus.metadata?.path).toBe(testProjectDir);
        expect(resumedStatus.metadata?.flavor).toBe(sourceStatus.metadata?.flavor);
    });

    it('spawns Codex, applies yolo permissions via message metadata, and creates a file in the test project', async () => {
        if (!activeMachineId || !integrationConfig || !agentHomeDir || !testProjectDir) {
            throw new Error('Integration environment not initialized');
        }

        const agentEnv = agentEnvVars(integrationConfig.serverPort, agentHomeDir);
        const proofFile = join(testProjectDir, 'codex-yolo-proof.txt');
        const prompt = 'Run a shell command to create ./codex-yolo-proof.txt with the exact contents yolo-codex-ok, then finish.';

        const spawnResult = parseJson<{
            type: 'success' | 'requestToApproveDirectoryCreation' | 'error';
            sessionId?: string;
            machineId?: string;
            directory?: string;
            agent?: string | null;
        }>(
            runAgentCli([
                'spawn',
                '--machine',
                activeMachineId,
                '--path',
                testProjectDir,
                '--agent',
                'codex',
                '--json',
            ], agentEnv),
        );

        expect(spawnResult.type).toBe('success');
        expect(spawnResult.directory).toBe(testProjectDir);
        expect(spawnResult.agent).toBe('codex');

        const sessionId = spawnResult.sessionId!;
        spawnedSessionIds.add(sessionId);

        await waitForSessionInList(sessionId, agentEnv);

        const status = parseJson<{
            id: string;
            metadata?: { path?: string; flavor?: string };
        }>(runAgentCli(['status', sessionId, '--json'], agentEnv));
        expect(status.id).toBe(sessionId);
        expect(status.metadata?.path).toBe(testProjectDir);
        expect(status.metadata?.flavor).toBe('codex');

        const sendResult = parseJson<{ sessionId: string; message: string; sent: boolean; permissionMode: string | null }>(
            runAgentCli(['send', sessionId, prompt, '--yolo', '--wait', '--json'], agentEnv),
        );
        expect(sendResult).toEqual({
            sessionId,
            message: prompt,
            sent: true,
            permissionMode: 'yolo',
        });
        await waitForFile(proofFile);

        expect(readFileSync(proofFile, 'utf-8').trim()).toBe('yolo-codex-ok');
        await waitForHistoryMessage(sessionId, prompt, agentEnv);
    });
});
