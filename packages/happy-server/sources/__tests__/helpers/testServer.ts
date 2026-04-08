import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { type Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

const packageRoot = process.cwd();
const tsxCliPathCandidates = [
    path.join(packageRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(packageRoot, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
];
const tsxCliPath = tsxCliPathCandidates.find((candidate) => existsSync(candidate));
if (!tsxCliPath) {
    throw new Error(`Unable to locate tsx CLI from ${packageRoot}`);
}

export interface TestServerOptions {
    port?: number;
    databaseUrl?: string;
    redisUrl?: string | null;
    handyMasterSecret?: string;
    publicUrl?: string;
    metricsEnabled?: boolean;
    extraEnv?: Record<string, string | undefined>;
    startupTimeoutMs?: number;
}

export interface HealthResponse {
    status: string;
    timestamp: string;
    service: string;
    processId: string;
    redis: 'ok' | 'error' | 'not configured';
    error?: string;
}

export interface TestServer {
    port: number;
    baseUrl: string;
    getLogs(): string;
    getHealth(): Promise<HealthResponse>;
    stop(): Promise<void>;
    kill(): Promise<void>;
}

async function getUnusedPort(): Promise<number> {
    const server = createServer();

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Failed to allocate an unused port');
    }

    const { port } = address;
    await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });

    return port;
}

type SpawnedTestServerProcess = ChildProcessByStdio<null, Readable, Readable>;

async function waitForServerReady(baseUrl: string, timeoutMs: number, child: SpawnedTestServerProcess, getLogs: () => string): Promise<HealthResponse> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
        if (child.exitCode !== null) {
            throw new Error(`Server exited before becoming healthy.\n\nLogs:\n${getLogs()}`);
        }

        try {
            const response = await fetch(`${baseUrl}/health`);
            if (response.ok) {
                const health = await response.json() as HealthResponse;
                await delay(100);
                return health;
            }
        } catch {
            // Server not ready yet.
        }

        await delay(100);
    }

    throw new Error(`Timed out waiting for server health at ${baseUrl}/health.\n\nLogs:\n${getLogs()}`);
}

export async function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
    const port = options.port ?? await getUnusedPort();
    const baseUrl = options.publicUrl ?? `http://127.0.0.1:${port}`;
    const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
    const handyMasterSecret = options.handyMasterSecret ?? process.env.HANDY_MASTER_SECRET;
    const startupTimeoutMs = options.startupTimeoutMs ?? 20_000;

    if (!databaseUrl) {
        throw new Error('DATABASE_URL must be configured before starting a test server');
    }
    if (!handyMasterSecret) {
        throw new Error('HANDY_MASTER_SECRET must be configured before starting a test server');
    }

    const env: NodeJS.ProcessEnv = {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(port),
        PUBLIC_URL: baseUrl,
        DATABASE_URL: databaseUrl,
        HANDY_MASTER_SECRET: handyMasterSecret,
        METRICS_ENABLED: options.metricsEnabled === false ? 'false' : (options.metricsEnabled ? 'true' : 'false'),
        ...options.extraEnv,
    };

    if (options.redisUrl === null) {
        delete env.REDIS_URL;
    } else if (options.redisUrl ?? process.env.REDIS_URL) {
        env.REDIS_URL = options.redisUrl ?? process.env.REDIS_URL;
    } else {
        delete env.REDIS_URL;
    }

    const child = spawn(process.execPath, [tsxCliPath!, './sources/main.ts'], {
        cwd: packageRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
    }) as SpawnedTestServerProcess;

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const appendChunk = (target: string[], chunk: Buffer) => {
        target.push(chunk.toString());
        if (target.length > 200) {
            target.splice(0, target.length - 200);
        }
    };

    child.stdout.on('data', (chunk: Buffer) => appendChunk(stdoutChunks, chunk));
    child.stderr.on('data', (chunk: Buffer) => appendChunk(stderrChunks, chunk));

    const exitPromise = new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
    });

    const getLogs = () => {
        const stdout = stdoutChunks.join('');
        const stderr = stderrChunks.join('');
        return `STDOUT:\n${stdout || '(empty)'}\n\nSTDERR:\n${stderr || '(empty)'}`;
    };

    function signalProcessGroup(signal: NodeJS.Signals): void {
        if (child.pid) {
            try {
                process.kill(-child.pid, signal);
                return;
            } catch (error) {
                const errno = (error as NodeJS.ErrnoException).code;
                if (errno !== 'ESRCH') {
                    throw error;
                }
            }
        }

        child.kill(signal);
    }

    async function terminate(signal: NodeJS.Signals, gracePeriodMs = 5_000): Promise<void> {
        if (child.exitCode !== null) {
            await exitPromise;
            return;
        }

        signalProcessGroup(signal);
        const exited = await Promise.race([
            exitPromise.then(() => true),
            delay(gracePeriodMs).then(() => false),
        ]);

        if (!exited && child.exitCode === null) {
            signalProcessGroup('SIGKILL');
            await exitPromise;
        }
    }

    try {
        await waitForServerReady(baseUrl, startupTimeoutMs, child, getLogs);
    } catch (error) {
        await terminate('SIGKILL', 1_000);
        throw error;
    }

    return {
        port,
        baseUrl,
        getLogs,
        async getHealth(): Promise<HealthResponse> {
            const response = await fetch(`${baseUrl}/health`);
            if (!response.ok) {
                throw new Error(`Health check failed for ${baseUrl}: ${response.status} ${response.statusText}.\n\nLogs:\n${getLogs()}`);
            }
            return await response.json() as HealthResponse;
        },
        async stop(): Promise<void> {
            await terminate('SIGTERM');
        },
        async kill(): Promise<void> {
            await terminate('SIGKILL', 1_000);
        }
    };
}

export { getUnusedPort };
