/**
 * CLI Helper - Utilities for testing happy-cli
 *
 * Provides functions to interact with the happy CLI for E2E tests.
 */

import { execSync, spawn, ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { SlotConfig } from './slots.js';

const ROOT_DIR = path.resolve(import.meta.dirname, '..', '..', '..');
const CLI_PATH = path.join(ROOT_DIR, 'happy-cli', 'bin', 'happy.mjs');

export interface DaemonHandle {
    process: ChildProcess | null;
    stop: () => Promise<void>;
}

/**
 * Get environment variables for CLI commands
 */
export function getCliEnv(config: SlotConfig): NodeJS.ProcessEnv {
    return {
        ...process.env,
        HAPPY_SERVER_URL: config.serverUrl,
        HAPPY_HOME_DIR: config.homeDir,
        // Clear any conflicting vars
        HAPPY_SERVER_PORT: undefined,
        HAPPY_WEBAPP_PORT: undefined,
        HAPPY_WEBAPP_URL: undefined,
    };
}

/**
 * Run a CLI command and return the output
 */
export function runCliCommand(
    config: SlotConfig,
    args: string[],
    options: { timeout?: number; input?: string } = {}
): { stdout: string; stderr: string; exitCode: number } {
    const { timeout = 30000, input } = options;
    const env = getCliEnv(config);

    try {
        const result = execSync(`node ${CLI_PATH} ${args.join(' ')}`, {
            env,
            timeout,
            input,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        return {
            stdout: result.toString(),
            stderr: '',
            exitCode: 0,
        };
    } catch (err: any) {
        return {
            stdout: err.stdout?.toString() || '',
            stderr: err.stderr?.toString() || '',
            exitCode: err.status || 1,
        };
    }
}

/**
 * Get CLI version
 */
export function getCliVersion(config: SlotConfig): string | null {
    const result = runCliCommand(config, ['--version']);
    if (result.exitCode === 0) {
        const match = result.stdout.match(/happy version (\S+)/);
        return match ? match[1] : result.stdout.trim();
    }
    return null;
}

/**
 * Start the daemon process
 */
export async function startDaemon(config: SlotConfig): Promise<DaemonHandle> {
    const env = getCliEnv(config);
    const logFile = path.join(config.logDir, 'daemon.log');

    // Ensure log directory exists
    fs.mkdirSync(config.logDir, { recursive: true });

    // Start daemon
    const result = runCliCommand(config, ['daemon', 'start']);

    if (result.exitCode !== 0) {
        throw new Error(`Failed to start daemon: ${result.stderr}`);
    }

    // Wait for daemon to be ready
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Check status
    const status = runCliCommand(config, ['daemon', 'status']);
    if (!status.stdout.includes('running')) {
        throw new Error(`Daemon not running after start: ${status.stdout}`);
    }

    return {
        process: null, // Daemon runs in background
        stop: async () => {
            runCliCommand(config, ['daemon', 'stop']);
        },
    };
}

/**
 * Stop the daemon process
 */
export async function stopDaemon(config: SlotConfig): Promise<void> {
    runCliCommand(config, ['daemon', 'stop']);
    // Give it time to stop
    await new Promise(resolve => setTimeout(resolve, 1000));
}

/**
 * Get daemon status
 */
export function getDaemonStatus(config: SlotConfig): 'running' | 'stopped' | 'unknown' {
    const result = runCliCommand(config, ['daemon', 'status']);
    if (result.stdout.includes('running')) {
        return 'running';
    }
    if (result.stdout.includes('stopped') || result.stdout.includes('not running')) {
        return 'stopped';
    }
    return 'unknown';
}

/**
 * Authenticate CLI with server using auto-generated credentials
 * Returns the secret key
 */
export async function authenticateCli(config: SlotConfig): Promise<string | null> {
    // First, check if already authenticated
    const statusResult = runCliCommand(config, ['auth', 'status']);
    if (statusResult.stdout.includes('authenticated')) {
        // Already authenticated, return existing key
        const keyFile = path.join(config.homeDir, 'access.key');
        if (fs.existsSync(keyFile)) {
            return fs.readFileSync(keyFile, 'utf-8').trim();
        }
    }

    // For E2E tests, we need to generate credentials
    // This typically requires the auto-auth script
    const autoAuthScript = path.join(ROOT_DIR, 'scripts', 'auto-auth.mjs');
    if (fs.existsSync(autoAuthScript)) {
        try {
            const result = execSync(`node ${autoAuthScript}`, {
                env: getCliEnv(config),
                encoding: 'utf-8',
                timeout: 30000,
            });

            // Extract secret key from output
            const match = result.match(/Secret key: (\S+)/);
            return match ? match[1] : null;
        } catch (err) {
            console.error('Auto-auth failed:', err);
            return null;
        }
    }

    return null;
}

/**
 * Create a new session
 */
export function createSession(
    config: SlotConfig,
    options: { name?: string; tag?: string } = {}
): { sessionId: string | null; error: string | null } {
    const args = ['session', 'create'];
    if (options.name) {
        args.push('--name', options.name);
    }
    if (options.tag) {
        args.push('--tag', options.tag);
    }

    const result = runCliCommand(config, args);

    if (result.exitCode !== 0) {
        return { sessionId: null, error: result.stderr || result.stdout };
    }

    // Extract session ID from output
    const match = result.stdout.match(/session[:\s]+([a-z0-9-]+)/i);
    return {
        sessionId: match ? match[1] : null,
        error: null,
    };
}

/**
 * List sessions
 */
export function listSessions(config: SlotConfig): string[] {
    const result = runCliCommand(config, ['session', 'list', '--json']);

    if (result.exitCode !== 0) {
        return [];
    }

    try {
        const data = JSON.parse(result.stdout);
        return Array.isArray(data) ? data.map((s: any) => s.id || s.sessionId) : [];
    } catch {
        // Parse text output
        const lines = result.stdout.split('\n');
        return lines
            .map(line => {
                const match = line.match(/([a-z0-9-]{36})/i);
                return match ? match[1] : null;
            })
            .filter((id): id is string => id !== null);
    }
}
