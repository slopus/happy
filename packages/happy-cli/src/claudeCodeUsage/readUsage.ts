/**
 * Orchestrates the daemon-side read of Claude Code rate-window quota.
 *
 *   1. `command -v claude`                               → installed?
 *   2. `claude auth status --json`                       → authenticated + subscription
 *   3. `claude --print --output-format json "/usage"`    → window text → parseUsageOutput
 *
 * Each spawn is bounded by an 8s timeout and never throws — failures are
 * normalised onto the `ClaudeCodeUsage` shape so the RPC handler in
 * apiMachine.ts can return a stable response. 0 token consumption is
 * verified by the response's `usage.input_tokens` field (informational —
 * caller logs but does not enforce).
 *
 * spec: specs/20260618-machine-cli-usage-quota/spec.md (R1, R6)
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '@/ui/logger';
import { parseUsageOutput } from './parseUsage';
import type { ClaudeCodeSubscription, ClaudeCodeUsage } from './types';

const execFileAsync = promisify(execFile);

const SPAWN_TIMEOUT_MS = 8_000;

interface AuthStatus {
    loggedIn?: boolean;
    authMethod?: string;
    apiProvider?: string;
    email?: string;
    subscriptionType?: ClaudeCodeSubscription;
}

interface UsageSdkResponse {
    type?: string;
    subtype?: string;
    result?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
}

async function detectInstalled(): Promise<{ installed: boolean; version?: string }> {
    try {
        const { stdout } = await execFileAsync('claude', ['--version'], {
            timeout: SPAWN_TIMEOUT_MS,
        });
        const versionMatch = stdout.trim().match(/^(\S+)/);
        return { installed: true, version: versionMatch?.[1] };
    } catch {
        return { installed: false };
    }
}

async function fetchAuthStatus(): Promise<AuthStatus | null> {
    try {
        const { stdout } = await execFileAsync('claude', ['auth', 'status', '--json'], {
            timeout: SPAWN_TIMEOUT_MS,
        });
        return JSON.parse(stdout) as AuthStatus;
    } catch (err) {
        logger.debug('[CLAUDE-CODE-USAGE] auth status failed', { err });
        return null;
    }
}

async function fetchUsageText(): Promise<{ result?: string; usedTokens?: number; raw?: string }> {
    try {
        const { stdout } = await execFileAsync(
            'claude',
            ['--print', '--output-format', 'json', '/usage'],
            { timeout: SPAWN_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        );
        const parsed = JSON.parse(stdout) as UsageSdkResponse;
        return {
            result: parsed.result,
            usedTokens:
                (parsed.usage?.input_tokens ?? 0) + (parsed.usage?.output_tokens ?? 0),
            raw: stdout,
        };
    } catch (err) {
        logger.debug('[CLAUDE-CODE-USAGE] /usage failed', { err });
        return {};
    }
}

export async function readClaudeCodeUsage(): Promise<ClaudeCodeUsage> {
    const refreshedAt = Date.now();

    const install = await detectInstalled();
    if (!install.installed) {
        return {
            refreshedAt,
            installed: false,
            authenticated: false,
            errorKind: 'not-installed',
            error: 'Claude Code CLI is not installed on this machine.',
        };
    }

    const auth = await fetchAuthStatus();
    if (!auth || auth.loggedIn !== true) {
        return {
            refreshedAt,
            installed: true,
            authenticated: false,
            cliVersion: install.version,
            subscriptionType: null,
            errorKind: 'not-authenticated',
            error: 'Claude Code CLI is not logged in.',
        };
    }

    const usage = await fetchUsageText();
    if (!usage.result) {
        return {
            refreshedAt,
            installed: true,
            authenticated: true,
            cliVersion: install.version,
            subscriptionType: auth.subscriptionType ?? null,
            errorKind: 'transport',
            error: 'Could not fetch /usage output from Claude Code CLI.',
        };
    }

    if (usage.usedTokens && usage.usedTokens > 0) {
        logger.debug('[CLAUDE-CODE-USAGE] non-zero tokens reported by /usage', {
            usedTokens: usage.usedTokens,
        });
    }

    const parsed = parseUsageOutput(usage.result);

    return {
        refreshedAt,
        installed: true,
        authenticated: true,
        cliVersion: install.version,
        subscriptionType: auth.subscriptionType ?? null,
        window5h: parsed.window5h,
        windowWeeklyAllModels: parsed.windowWeeklyAllModels,
        windowWeeklySonnet: parsed.windowWeeklySonnet,
        errorKind: parsed.parseError ? 'parse-failure' : undefined,
        error: parsed.parseError,
        rawUsageOutput: parsed.parseError ? usage.result : undefined,
    };
}
