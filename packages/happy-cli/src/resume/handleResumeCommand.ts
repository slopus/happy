import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { Metadata } from '@/api/types';
import { getProjectPath } from '@/claude/utils/path';
import { encodeBase64 } from '@/api/encryption';
import { hasLocalHappyAgentAuth } from '@/resume/localHappyAgentAuth';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { buildSessionChildEnvironment, sanitizeSessionEnvironment } from '@/daemon/sessionEnvironment';

import { LocalResumeSessionError, resolveLocalReconnectableSession } from './localResumeStore';
import { resolveHappySession, type ReconnectableHappySession, type ResumableHappySession } from './resolveHappySession';

export type ResumeLaunch = {
    cwd: string;
    args: string[];
};

export type ResumeLaunchOptions = {
    claudeStartingMode?: 'local' | 'remote';
    startedBy?: 'daemon' | 'terminal';
};

export function parseResumeCommandArgs(args: string[]): { showHelp: boolean; sessionId: string } {
    if (args.includes('-h') || args.includes('--help')) {
        return {
            showHelp: true,
            sessionId: '',
        };
    }

    if (args.length === 0) {
        throw new Error('Happy session ID is required: happy resume <session-id>');
    }
    if (args.length > 1) {
        throw new Error(`Unexpected arguments for happy resume: ${args.slice(1).join(' ')}`);
    }

    return {
        showHelp: false,
        sessionId: args[0],
    };
}

function resolveFlavor(metadata: Metadata): 'codex' | 'claude' | null {
    if (metadata.flavor === 'codex' || metadata.codexThreadId) {
        return 'codex';
    }
    if (metadata.flavor === 'claude' || metadata.claudeSessionId) {
        return 'claude';
    }
    return null;
}

/**
 * Why a resume can point at a transcript that is no longer there.
 *
 * A session record survives in `~/.happy/sessions.json` on two criteria
 * (`readPersistedSessions`): the host process is alive, or the record is
 * younger than the retention window. Neither says anything about the Claude
 * transcript, which lives outside Happy in `~/.claude/projects/<slug>/` and
 * can vanish on its own — Claude Code's retention sweep (`cleanupPeriodDays`),
 * a user clearing the directory, `CLAUDE_CONFIG_DIR` changing, or the project
 * being renamed, which changes the slug so the old file is no longer where
 * `getProjectPath` looks.
 *
 * Without this check the session stays listed and clickable, and every message
 * spawns a `claude --resume` that dies with "No conversation found with session
 * ID" — an inert tab that swallows input and never says why.
 */
export function missingClaudeTranscriptReason(metadata: Metadata): string | null {
    if (resolveFlavor(metadata) !== 'claude' || !metadata.claudeSessionId) {
        return null;
    }
    const transcript = join(getProjectPath(metadata.path), `${metadata.claudeSessionId}.jsonl`);
    if (existsSync(transcript)) {
        return null;
    }
    return `The Claude transcript for this session no longer exists at ${transcript}, so it cannot be resumed. Start a new session instead.`;
}

export function buildResumeLaunch(session: ResumableHappySession, options: ResumeLaunchOptions = {}): ResumeLaunch {
    const { metadata } = session;
    const flavor = resolveFlavor(metadata);

    if (flavor === 'codex') {
        if (!metadata.codexThreadId) {
            throw new Error(`Happy session ${session.id} is missing its Codex thread ID.`);
        }
        const args = ['codex', '--resume', metadata.codexThreadId];
        if (options.startedBy) {
            args.push('--started-by', options.startedBy);
        }
        return {
            cwd: metadata.path,
            args,
        };
    }

    if (flavor === 'claude') {
        if (!metadata.claudeSessionId) {
            throw new Error(`Happy session ${session.id} is missing its Claude session ID.`);
        }
        const args = ['claude'];
        if (options.claudeStartingMode) {
            args.push('--happy-starting-mode', options.claudeStartingMode);
        }
        if (options.startedBy) {
            args.push('--started-by', options.startedBy);
        }
        args.push('--resume', metadata.claudeSessionId);
        return {
            cwd: metadata.path,
            args,
        };
    }

    throw new Error(`Happy session ${session.id} uses unsupported flavor "${metadata.flavor ?? 'unknown'}".`);
}

export function formatResumeHelp(): string {
    return [
        'happy resume - Resume a previous Happy session',
        '',
        'Usage:',
        '  happy resume <happy-session-id>',
        '',
        'Examples:',
        '  happy resume cmmij8olq00dp5jcxr3wtbpau',
        '  happy resume cmmij8',
        '',
        'This reuses the saved worktree/path and resumes the underlying agent session',
        'when the backend supports it.',
    ].join('\n');
}

function buildReconnectEnv(session: ReconnectableHappySession): NodeJS.ProcessEnv {
    return buildSessionChildEnvironment(process.env, {
        HAPPY_RECONNECT_SESSION_ID: session.id,
        HAPPY_RECONNECT_ENCRYPTION_KEY: encodeBase64(session.encryptionKey),
        HAPPY_RECONNECT_ENCRYPTION_VARIANT: session.encryptionVariant,
        HAPPY_RECONNECT_SEQ: String(session.seq),
        HAPPY_RECONNECT_METADATA_VERSION: String(session.metadataVersion),
        HAPPY_RECONNECT_AGENT_STATE_VERSION: String(session.agentStateVersion),
    });
}

function spawnResumeChild(launch: ResumeLaunch, env: NodeJS.ProcessEnv = sanitizeSessionEnvironment(process.env)): Promise<number | null> {
    return new Promise((resolve, reject) => {
        const child = spawnHappyCLI(launch.args, {
            cwd: launch.cwd,
            env,
            stdio: 'inherit',
        });

        child.once('error', reject);
        child.once('exit', (code, signal) => {
            if (signal) {
                reject(new Error(`Resumed session exited via signal ${signal}`));
                return;
            }
            resolve(code);
        });
    });
}

async function resolveLegacySessionIfAvailable(sessionId: string): Promise<ResumableHappySession | null> {
    if (!hasLocalHappyAgentAuth()) {
        return null;
    }
    return resolveHappySession(sessionId);
}

export async function handleResumeCommand(args: string[]): Promise<void> {
    const parsed = parseResumeCommandArgs(args);
    if (parsed.showHelp) {
        console.log(formatResumeHelp());
        return;
    }

    let localError: unknown;
    let reconnectableSession: ReconnectableHappySession | null = null;
    try {
        reconnectableSession = await resolveLocalReconnectableSession(parsed.sessionId);
    } catch (error) {
        localError = error;
        if (error instanceof LocalResumeSessionError && error.code === 'ambiguous') {
            throw error;
        }
    }

    if (reconnectableSession) {
        const launch = buildResumeLaunch(reconnectableSession);

        if (!existsSync(launch.cwd)) {
            throw new Error(`Saved session path does not exist: ${launch.cwd}`);
        }

        const missingTranscript = missingClaudeTranscriptReason(reconnectableSession.metadata);
        if (missingTranscript) {
            throw new Error(missingTranscript);
        }

        const exitCode = await spawnResumeChild(launch, buildReconnectEnv(reconnectableSession));
        if (typeof exitCode === 'number' && exitCode !== 0) {
            process.exit(exitCode);
        }
        return;
    }

    const session = await resolveLegacySessionIfAvailable(parsed.sessionId);
    if (!session) {
        throw localError;
    }
    const launch = buildResumeLaunch(session);

    if (!existsSync(launch.cwd)) {
        throw new Error(`Saved session path does not exist: ${launch.cwd}`);
    }

    const missingLegacyTranscript = missingClaudeTranscriptReason(session.metadata);
    if (missingLegacyTranscript) {
        throw new Error(missingLegacyTranscript);
    }

    const exitCode = await spawnResumeChild(launch);
    if (typeof exitCode === 'number' && exitCode !== 0) {
        process.exit(exitCode);
    }
}
