import { listWorkspaceDirectory, readWorkspaceFile } from './workspaceFileBoundary';
import { fileDiscovery } from './fileDiscovery';
import { logger } from '@/ui/logger';
import { exec, ExecOptions } from 'child_process';
import { promisify } from 'util';
import { open, readFile, writeFile, readdir, stat, mkdir, rename, rm, cp } from 'fs/promises';
import { createHash } from 'crypto';
import { dirname, join, basename, extname, resolve } from 'path';
import { run as runRipgrep } from '@/modules/ripgrep/index';
import { run as runDifftastic } from '@/modules/difftastic/index';
import { RpcHandlerManager } from '../../api/rpc/RpcHandlerManager';
import type { AiAuthSelection } from '@/daemon/sessionEnv';
import type { ReconnectSessionEnvironment } from '@/daemon/reconnectSessionEnv';
import type { AiAuthSource } from '@/usage/aiAuthSource';
import { validatePath } from './pathSecurity';
import { ensureDirectory } from './ensureDirectory';
import { createIgnoreMatcher } from './ignorePresets';
import {
    createGitignoreContext,
    enterDirectory,
    type GitignoreContext,
} from './gitignoreWalker';
import {
    BashRpcBusyError,
    createBashRpcScheduler,
    type BashRpcExecutionClass,
} from './bashRpcScheduler';
import type { PermissionMode } from '@/api/types';

const execAsync = promisify(exec);
const READ_FILE_CHUNK_MAX_BYTES = 3 * 1024 * 1024;

// Preset matcher is immutable at runtime — one instance covers every
// getDirectoryTree call. Gitignore rules cascade per-request from this
// baseline context.
const directoryIgnoreMatcher = createIgnoreMatcher();
const baseDirectoryIgnoreContext = createGitignoreContext(directoryIgnoreMatcher);

interface BashRequest {
    command: string;
    cwd?: string;
    timeout?: number; // timeout in milliseconds
    executionClass?: BashRpcExecutionClass;
}

interface BashResponse {
    success: boolean;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    error?: string;
    errorCode?: 'DAEMON_BUSY';
    retryAfterMs?: number;
}

interface ReadFileRequest {
    path: string;
}

interface ReadFileResponse {
    success: boolean;
    content?: string; // base64 encoded
    error?: string;
}

interface ReadFileChunkRequest {
    path: string;
    offset: number;
    length: number;
}

interface ReadFileChunkResponse {
    success: boolean;
    content?: string; // base64 encoded
    offset?: number;
    bytesRead?: number;
    totalBytes?: number;
    modified?: number;
    eof?: boolean;
    error?: string;
}

interface WriteFileRequest {
    path: string;
    content: string; // base64 encoded
    expectedHash?: string | null; // null for new files, hash for existing files
}

interface WriteFileResponse {
    success: boolean;
    hash?: string; // hash of written file
    error?: string;
}

interface ListDirectoryRequest {
    path: string;
}

interface DirectoryEntry {
    name: string;
    type: 'file' | 'directory' | 'other';
    size?: number;
    modified?: number; // timestamp
}

interface ListDirectoryResponse {
    success: boolean;
    entries?: DirectoryEntry[];
    error?: string;
}

interface EnsureDirectoryRequest {
    path: string;
}

interface EnsureDirectoryResponse {
    success: boolean;
    error?: string;
}

interface GetDirectoryTreeRequest {
    path: string;
    maxDepth: number;
}

interface TreeNode {
    name: string;
    path: string;
    type: 'file' | 'directory';
    size?: number;
    modified?: number;
    children?: TreeNode[]; // Only present for directories
}

interface GetDirectoryTreeResponse {
    success: boolean;
    tree?: TreeNode;
    error?: string;
}

interface RipgrepRequest {
    args: string[];
    cwd?: string;
}

interface RipgrepResponse {
    success: boolean;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    error?: string;
}

interface DifftasticRequest {
    args: string[];
    cwd?: string;
}

interface DifftasticResponse {
    success: boolean;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    error?: string;
}

interface RenameFileRequest {
    path: string;
    newName: string;
}

interface RenameFileResponse {
    success: boolean;
    path?: string;
    error?: string;
}

interface DeleteFileRequest {
    path: string;
}

interface DeleteFileResponse {
    success: boolean;
    error?: string;
}

interface CopyFileRequest {
    path: string;
    newName?: string;
}

interface CopyFileResponse {
    success: boolean;
    path?: string;
    name?: string;
    error?: string;
}

/*
 * Spawn Session Options and Result
 * This rpc type is used by the daemon, all other RPCs here are for sessions
*/

export interface SpawnSessionOptions {
    machineId?: string;
    directory: string;
    sessionId?: string;
    approvedNewDirectoryCreation?: boolean;
    agent?: 'claude' | 'codex' | 'gemini' | 'grok' | 'openclaw' | 'opencode';
    /**
     * Initial model/effort seed for the spawned agent, delivered via
     * HAPPY_INITIAL_MODEL / HAPPY_INITIAL_EFFORT (per-spawn lineage envs,
     * scrubbed like HAPPY_INITIAL_PROMPT) and consumed exactly once by the
     * agent startup path. Invalid effort values are ignored by the agent.
     */
    model?: string;
    effort?: string;
    environmentVariables?: Record<string, string>;
    /** Existing, daemon-canonicalized read-write roots mounted for this session. */
    additionalDirectories?: string[];
    /** OAuth token for the agent CLI (e.g. CLAUDE_CODE_OAUTH_TOKEN). */
    token?: string;
    /**
     * Happy server auth credentials of the requesting user. When present, the
     * daemon writes them to a per-spawn access.key so the child CLI attributes
     * its session to that user instead of the daemon.
     */
    happyToken?: string;
    happySecret?: string;
    /**
     * Opaque caller grant encrypted to this daemon process's ephemeral public
     * key. The shared RPC layer may expose the envelope to company members, so
     * plaintext grants and personal Happy credentials must never replace it.
     */
    mcpCallerGrantEnvelope?: string;
    /** Project scope appended only to the daemon-owned MCP config URL. */
    mcpConfigProjectId?: string;
    /** Connected provider names expected in the child MCP topology. */
    expectedConnectors?: string[];
    /**
     * If set, the daemon spawns the agent with `--resume <id>` so the new
     * Happy session continues from an existing Claude conversation file.
     * Used by the session fork / duplicate flow: the fork RPC produces a
     * new Claude JSONL on disk, the spawn RPC then attaches a fresh Happy
     * session to it.
     */
    resumeClaudeSessionId?: string;
    /**
     * If set, the daemon spawns Codex with `--resume <id>` so a fresh Happy
     * session attaches to a forked Codex app-server thread.
     */
    resumeCodexThreadId?: string;
    /** Prior transcript context applied to the first explicit user turn only. */
    deferredContinuationContext?: string;
    /**
     * The managed Cloud spawn envelope (specs/managed-cloud-byos §5.33).
     *
     * Accepted only from a verified managed dispatch on a runtime whose own
     * identity is active; a caller cannot turn managed mode on by supplying
     * this, and supplying it does not relax any of the ordinary guards.
     */
    bootstrap?: unknown;
    gateway?: unknown;
    /** Happy session id this fork was branched from (lineage). */
    parentSessionId?: string;
    /** Happy message id used as the rewind point (only set for "duplicate"). */
    forkedFromMessageId?: string;
    /**
     * Identity of the account that requested this spawn, as known by the
     * client (e.g. the desktop app). Threaded into the new session's
     * metadata as `createdBy` so shared-account orgs can approximate "my
     * conversations" (specs/session-created-by). Not lineage — re-supplied
     * on every spawn, never inherited from a previous process's env.
     */
    createdByAccountId?: string;
    createdByDisplayName?: string;
    axStep?: 'plan' | 'design' | 'free';
    bootstrapFiles?: Array<{ relativePath: string; content: string }>;
    /**
     * First user prompt for the spawned session. Delivered via
     * HAPPY_INITIAL_PROMPT (a per-spawn lineage env, scrubbed like
     * HAPPY_FORK*) and consumed exactly once by supported agent startup
     * paths so the agent starts its first turn without waiting for app input.
     * Used by scheduled automations.
     */
    initialPrompt?: string;
    /** Web optimistic message id preserved on the initial prompt server row. */
    initialPromptLocalId?: string;
    /** User/project/operational prompt preserved for an atomically delivered first turn. */
    appendSystemPrompt?: string;
    /** Saycode-owned prompt policy applied to an atomically delivered initial prompt. */
    saycodeSystemPromptEnabled?: boolean;
    /** Per-block Saycode overrides seeded into the spawned session's first turn. */
    saycodePromptBlocks?: Record<string, boolean>;
    /** Exit cleanly after the spawned agent completes its first turn. */
    exitAfterFirstTurn?: boolean;
    /**
     * Run-once only: the host keeps the session parked while an Agent Browser task waits for the user
     * (Studio Chat(beta)), so the agent is told the chat continues after the console action.
     */
    browserContinuation?: boolean;
    /**
     * Shared Agent Browser machines: Studio's signed statement of who started this new chat (abp2
     * session-user). The daemon hands it to the Runtime broker only (never to the child's env); the broker
     * verifies it and binds the session to that user's browser profile.
     */
    browserAttestation?: string;
    /**
     * Internal only. Set by the daemon's managed dispatch wrapper, never read
     * from RPC params — a caller that supplied it would be choosing its own
     * delivery guarantees. Turns on confirmed delivery of the initial prompt
     * and nothing else; it conveys no identity or permission.
     */
    requireInitialPromptAck?: boolean;
    /**
     * Internal only. Attaches the child to a session the daemon already created (the channel host
     * spawn), with the key the daemon sealed it with — the same HAPPY_RECONNECT_* handoff a resume
     * uses. Never read from RPC params: `spawn-happy-session` names its fields, and a caller that
     * could set this would point a new child at somebody else's session.
     */
    reconnectEnvironment?: ReconnectSessionEnvironment;
    /** Remove inherited daemon credentials before applying the explicit spawn environment. */
    filterInheritedCredentials?: boolean;
    /** Restrict an unattended automation session to repository reads. */
    permissionMode?: PermissionMode;
    /**
     * Which credential the requester explicitly chose for this spawn.
     *
     * Only sent by a client that saw the daemon advertise
     * `MachineMetadata.aiAuthSelection`. Absent means "whatever the machine
     * would have used", which is the behaviour that predates the choice.
     */
    aiAuthSelection?: AiAuthSelection;
}

export type SpawnSessionResult =
    | {
        type: 'success';
        sessionId: string;
        /**
         * Which credential the daemon actually applied, as the usage ledger
         * names it. Reported so a requester can tell what ran from what it
         * asked for; `unknown` is an answer, not a missing value.
         */
        appliedAiAuthSource?: AiAuthSource;
        additionalDirectories?: {
            version: 1;
            accepted: string[];
            skipped: Partial<Record<'missing' | 'not-directory' | 'canonicalize-failed' | 'duplicate' | 'primary', number>>;
        };
    }
    | { type: 'requestToApproveDirectoryCreation'; directory: string }
    | { type: 'error'; errorMessage: string };

export type ResumeSessionErrorCode =
    | 'SESSION_LIVE'
    | 'SESSION_NOT_TRACKED'
    | 'SESSION_METADATA_MISSING'
    | 'SESSION_ENCRYPTION_MISSING'
    | 'SESSION_IDENTITY_MISMATCH'
    | 'SESSION_CURSOR_MISSING'
    | 'SESSION_SERVER_UNAVAILABLE'
    | 'SESSION_ALIVE_ELSEWHERE'
    | 'SESSION_DIRECTORY_MISMATCH'
    | 'SESSION_DIRECTORY_MISSING'
    | 'SESSION_NATIVE_SESSION_MISSING'
    | 'MCP_CALLER_GRANT_REJECTED'
    | 'SESSION_RESUME_FAILED';

export type ResumeSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'requestToApproveDirectoryCreation'; directory: string }
    | { type: 'error'; code: ResumeSessionErrorCode; errorMessage: string };

export type RecoverSessionOptions = {
    initialPrompt: string;
    initialPromptLocalId?: string;
    appendSystemPrompt?: string;
    saycodeSystemPromptEnabled?: boolean;
    /** Per-block Saycode overrides for the recovered first turn (sanitized at the RPC boundary). */
    saycodePromptBlocks?: Record<string, boolean>;
    environmentVariables?: Record<string, string>;
    model?: string;
    permissionMode?: PermissionMode;
    mcpCallerGrantEnvelope?: string;
    mcpConfigProjectId?: string;
    expectedConnectors?: string[];
};

export type RecoverSessionResult =
    | {
        type: 'success';
        sessionId: string;
        previousSessionId: string;
        recovery: 'same-session' | 'new-session';
        initialPromptDelivered: boolean;
    }
    | { type: 'error'; code: ResumeSessionErrorCode; errorMessage: string };

/**
 * Register all RPC handlers with the session
 */
export function registerCommonHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string) {
    rpcHandlerManager.registerHandler('file-discovery', (request: unknown) => fileDiscovery(workingDirectory, request));
    const bashScheduler = createBashRpcScheduler();

    // Shell command handler - executes commands in the default shell
    rpcHandlerManager.registerHandler<BashRequest, BashResponse>('bash', async (data) => {
        logger.debug('Shell command request:', data.command);

        // Validate cwd if provided
        // Special case: "/" means "use shell's default cwd" (used by CLI detection)
        // Security: Still validate all other paths to prevent directory traversal
        if (data.cwd && data.cwd !== '/') {
            const validation = validatePath(data.cwd, workingDirectory);
            if (!validation.valid) {
                return { success: false, error: validation.error };
            }
            data.cwd = validation.resolvedPath;
        }

        const executionClass = data.executionClass === 'background' ? 'background' : 'foreground';
        const schedulerState = bashScheduler.snapshot();
        if (schedulerState.queued > 0 || schedulerState.running >= 8) {
            logger.debug('Shell command queued', { executionClass, ...schedulerState });
        }
        try {
            return await bashScheduler.run(executionClass, async () => {
                try {
                    // Build options with shell enabled by default
                    // Note: ExecOptions doesn't support boolean for shell, but exec() uses the default shell when shell is undefined
                    // If cwd is "/", use undefined to let shell use its default (respects user's PATH)
                    const options: ExecOptions = {
                        cwd: data.cwd === '/' ? undefined : data.cwd,
                        timeout: data.timeout || 30000, // Default 30 seconds timeout
                        windowsHide: true, // Prevent cmd.exe popup on Windows for every RPC bash call
                    };

                    logger.debug('Shell command executing...', { cwd: options.cwd, timeout: options.timeout });
                    const { stdout, stderr } = await execAsync(data.command, options);
                    logger.debug('Shell command executed, processing result...');

                    const result = {
                        success: true,
                        stdout: stdout ? stdout.toString() : '',
                        stderr: stderr ? stderr.toString() : '',
                        exitCode: 0
                    };
                    logger.debug('Shell command result:', {
                        success: true,
                        exitCode: 0,
                        stdoutLen: result.stdout.length,
                        stderrLen: result.stderr.length
                    });
                    return result;
                } catch (error) {
                    const execError = error as NodeJS.ErrnoException & {
                        stdout?: string;
                        stderr?: string;
                        code?: number | string;
                        killed?: boolean;
                    };

                    // Check if the error was due to timeout
                    if (execError.code === 'ETIMEDOUT' || execError.killed) {
                        const result = {
                            success: false,
                            stdout: execError.stdout || '',
                            stderr: execError.stderr || '',
                            exitCode: typeof execError.code === 'number' ? execError.code : -1,
                            error: 'Command timed out'
                        };
                        logger.debug('Shell command timed out:', {
                            success: false,
                            exitCode: result.exitCode,
                            error: 'Command timed out'
                        });
                        return result;
                    }

                    // If exec fails, it includes stdout/stderr in the error
                    const result = {
                        success: false,
                        stdout: execError.stdout ? execError.stdout.toString() : '',
                        stderr: execError.stderr ? execError.stderr.toString() : execError.message || 'Command failed',
                        exitCode: typeof execError.code === 'number' ? execError.code : 1,
                        error: execError.message || 'Command failed'
                    };
                    logger.debug('Shell command failed:', {
                        success: false,
                        exitCode: result.exitCode,
                        error: result.error,
                        stdoutLen: result.stdout.length,
                        stderrLen: result.stderr.length
                    });
                    return result;
                }
            });
        } catch (error) {
            if (error instanceof BashRpcBusyError) {
                const state = bashScheduler.snapshot();
                logger.debug('Shell command rejected: daemon busy', { executionClass, ...state });
                return {
                    success: false,
                    stdout: '',
                    stderr: '',
                    exitCode: -1,
                    error: error.message,
                    errorCode: error.errorCode,
                    retryAfterMs: error.retryAfterMs,
                };
            }
            throw error;
        }
    });

    // Read file handler - returns base64 encoded content
    rpcHandlerManager.registerHandler<ReadFileRequest, ReadFileResponse>('readFile', async (data) => {
        logger.debug('Read file request:', data.path);

        // Validate path is within working directory
        const validation = validatePath(data.path, workingDirectory);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }

        try {
            const buffer = await readFile(validation.resolvedPath!);
            const content = buffer.toString('base64');
            return { success: true, content };
        } catch (error) {
            logger.debug('Failed to read file:', error);
            return { success: false, error: error instanceof Error ? error.message : 'Failed to read file' };
        }
    });

    rpcHandlerManager.registerHandler<ReadFileChunkRequest, ReadFileChunkResponse>('readFileChunk', async (data) => {
        const validation = validatePath(data.path, workingDirectory);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }
        if (!Number.isSafeInteger(data.offset) || data.offset < 0) {
            return { success: false, error: 'Chunk offset must be a non-negative integer' };
        }
        if (!Number.isSafeInteger(data.length) || data.length < 1 || data.length > READ_FILE_CHUNK_MAX_BYTES) {
            return {
                success: false,
                error: `Chunk length must be an integer between 1 and ${READ_FILE_CHUNK_MAX_BYTES} bytes`,
            };
        }

        try {
            const file = await open(validation.resolvedPath!, 'r');
            try {
                const stats = await file.stat();
                const length = Math.min(data.length, Math.max(0, stats.size - data.offset));
                const buffer = Buffer.alloc(length);
                const { bytesRead } = length > 0
                    ? await file.read(buffer, 0, length, data.offset)
                    : { bytesRead: 0 };
                return {
                    success: true,
                    content: buffer.subarray(0, bytesRead).toString('base64'),
                    offset: data.offset,
                    bytesRead,
                    totalBytes: stats.size,
                    modified: stats.mtimeMs,
                    eof: data.offset + bytesRead >= stats.size,
                };
            } finally {
                await file.close();
            }
        } catch (error) {
            logger.debug('Failed to read file chunk:', error);
            return { success: false, error: error instanceof Error ? error.message : 'Failed to read file chunk' };
        }
    });

    // Write file handler - with hash verification
    rpcHandlerManager.registerHandler<WriteFileRequest, WriteFileResponse>('writeFile', async (data) => {
        logger.debug('Write file request:', data.path);

        // Validate path is within working directory
        const validation = validatePath(data.path, workingDirectory);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }

        try {
            // If expectedHash is provided (not null), verify existing file
            if (data.expectedHash !== null && data.expectedHash !== undefined) {
                try {
                    const existingBuffer = await readFile(validation.resolvedPath!);
                    const existingHash = createHash('sha256').update(existingBuffer).digest('hex');

                    if (existingHash !== data.expectedHash) {
                        return {
                            success: false,
                            error: `File hash mismatch. Expected: ${data.expectedHash}, Actual: ${existingHash}`
                        };
                    }
                } catch (error) {
                    const nodeError = error as NodeJS.ErrnoException;
                    if (nodeError.code !== 'ENOENT') {
                        throw error;
                    }
                    // File doesn't exist but hash was provided
                    return {
                        success: false,
                        error: 'File does not exist but hash was provided'
                    };
                }
            } else {
                // expectedHash is null - expecting new file
                try {
                    await stat(validation.resolvedPath!);
                    // File exists but we expected it to be new
                    return {
                        success: false,
                        error: 'File already exists but was expected to be new'
                    };
                } catch (error) {
                    const nodeError = error as NodeJS.ErrnoException;
                    if (nodeError.code !== 'ENOENT') {
                        throw error;
                    }
                    // File doesn't exist - this is expected
                }
            }

            // Write the file. Auto-create the parent directory so the
            // first writeFile to a freshly-bound project doesn't fail
            // with ENOENT (specs/project-workspace-auto-create/ Phase 2).
            // mkdir({ recursive: true }) is idempotent and stays inside
            // the validated path, so traversal defense is unaffected.
            const buffer = Buffer.from(data.content, 'base64');
            await mkdir(dirname(validation.resolvedPath!), { recursive: true });
            await writeFile(validation.resolvedPath!, buffer);

            // Calculate and return hash of written file
            const hash = createHash('sha256').update(buffer).digest('hex');

            return { success: true, hash };
        } catch (error) {
            logger.debug('Failed to write file:', error);
            return { success: false, error: error instanceof Error ? error.message : 'Failed to write file' };
        }
    });

    // List directory handler
    // Separate method names are the capability gate: old daemons must not
    // silently ignore workspaceRoot and execute a machine-wide read.
    for (const operation of ['listWorkspaceDirectory', 'readWorkspaceFile'] as const) {
        rpcHandlerManager.registerHandler<{ workspaceRoot: string; path: string }, object>(operation, async (data) => {
            try {
                if (operation === 'listWorkspaceDirectory') {
                    return { success: true, entries: await listWorkspaceDirectory(workingDirectory, data.workspaceRoot, data.path) };
                }
                return { success: true, content: (await readWorkspaceFile(workingDirectory, data.workspaceRoot, data.path)).toString('base64') };
            } catch (error) {
                return {
                    success: false,
                    error: error instanceof Error ? error.message : 'Workspace read failed',
                    errorCode: error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'WORKSPACE_READ_FAILED',
                };
            }
        });
    }

    rpcHandlerManager.registerHandler<ListDirectoryRequest, ListDirectoryResponse>('listDirectory', async (data) => {
        logger.debug('List directory request:', data.path);

        // Validate path is within working directory
        const validation = validatePath(data.path, workingDirectory);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }

        try {
            const directoryPath = validation.resolvedPath!;
            const entries = await readdir(directoryPath, { withFileTypes: true });

            const directoryEntries: DirectoryEntry[] = await Promise.all(
                entries.map(async (entry) => {
                    const fullPath = join(directoryPath, entry.name);
                    let type: 'file' | 'directory' | 'other' = 'other';
                    let size: number | undefined;
                    let modified: number | undefined;

                    if (entry.isDirectory()) {
                        type = 'directory';
                    } else if (entry.isFile()) {
                        type = 'file';
                    }

                    try {
                        const stats = await stat(fullPath);
                        size = stats.size;
                        modified = stats.mtime.getTime();
                    } catch (error) {
                        // Ignore stat errors for individual files
                        logger.debug(`Failed to stat ${fullPath}:`, error);
                    }

                    return {
                        name: entry.name,
                        type,
                        size,
                        modified
                    };
                })
            );

            // Sort entries: directories first, then files, alphabetically
            directoryEntries.sort((a, b) => {
                if (a.type === 'directory' && b.type !== 'directory') return -1;
                if (a.type !== 'directory' && b.type === 'directory') return 1;
                return a.name.localeCompare(b.name);
            });

            return { success: true, entries: directoryEntries };
        } catch (error) {
            logger.debug('Failed to list directory:', error);
            return { success: false, error: error instanceof Error ? error.message : 'Failed to list directory' };
        }
    });

    // Rename file or directory handler
    rpcHandlerManager.registerHandler<RenameFileRequest, RenameFileResponse>('renameFile', async (data) => {
        logger.debug('Rename file request:', data.path, 'newName:', data.newName);

        // Validate original path is within working directory
        const validation = validatePath(data.path, workingDirectory);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }

        // Validate newName
        const trimmedName = data.newName.trim();
        if (!trimmedName) {
            return { success: false, error: 'Invalid name' };
        }
        if (trimmedName.includes('/') || trimmedName.includes('\\')) {
            return { success: false, error: 'Invalid name' };
        }
        if (trimmedName === '.' || trimmedName === '..') {
            return { success: false, error: 'Invalid name' };
        }

        try {
            // Construct new path
            const newPath = join(dirname(validation.resolvedPath!), trimmedName);

            // Validate new path is within working directory
            const newValidation = validatePath(newPath, workingDirectory);
            if (!newValidation.valid) {
                return { success: false, error: newValidation.error };
            }

            // Check if target with new name already exists
            try {
                await stat(newValidation.resolvedPath!);
                return { success: false, error: 'A file or folder with that name already exists' };
            } catch (error) {
                const nodeError = error as NodeJS.ErrnoException;
                if (nodeError.code !== 'ENOENT') {
                    throw error;
                }
                // File doesn't exist - this is expected
            }

            // Perform rename
            await rename(validation.resolvedPath!, newValidation.resolvedPath!);
            return { success: true, path: newValidation.resolvedPath };
        } catch (error) {
            logger.debug('Failed to rename:', error);
            return { success: false, error: error instanceof Error ? error.message : 'Failed to rename' };
        }
    });

    // Delete file or directory handler
    rpcHandlerManager.registerHandler<DeleteFileRequest, DeleteFileResponse>('deleteFile', async (data) => {
        logger.debug('Delete file request:', data.path);

        // Validate path is within working directory
        const validation = validatePath(data.path, workingDirectory);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }

        try {
            // Prevent deletion of the project root directory
            const resolvedWorkingDir = resolve(workingDirectory);
            if (validation.resolvedPath === resolvedWorkingDir) {
                return { success: false, error: 'Cannot delete the project root directory' };
            }

            // Perform deletion
            await rm(validation.resolvedPath!, { recursive: true, force: false });
            return { success: true };
        } catch (error) {
            logger.debug('Failed to delete:', error);
            return { success: false, error: error instanceof Error ? error.message : 'Failed to delete' };
        }
    });

    // Copy file or directory handler
    rpcHandlerManager.registerHandler<CopyFileRequest, CopyFileResponse>('copyFile', async (data) => {
        logger.debug('Copy file request:', data.path, 'newName:', data.newName);

        // Validate source path is within working directory
        const validation = validatePath(data.path, workingDirectory);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }

        try {
            let targetPath: string;
            let targetName: string;

            if (data.newName) {
                // Use provided name
                const trimmedName = data.newName.trim();
                if (!trimmedName) {
                    return { success: false, error: 'Invalid name' };
                }
                if (trimmedName.includes('/') || trimmedName.includes('\\')) {
                    return { success: false, error: 'Invalid name' };
                }
                if (trimmedName === '.' || trimmedName === '..') {
                    return { success: false, error: 'Invalid name' };
                }

                targetName = trimmedName;
                targetPath = join(dirname(validation.resolvedPath!), trimmedName);

                // Validate new path is within working directory
                const newValidation = validatePath(targetPath, workingDirectory);
                if (!newValidation.valid) {
                    return { success: false, error: newValidation.error };
                }
                targetPath = newValidation.resolvedPath!;

                // Check if target already exists
                try {
                    await stat(targetPath);
                    return { success: false, error: 'A file or folder with that name already exists' };
                } catch (error) {
                    const nodeError = error as NodeJS.ErrnoException;
                    if (nodeError.code !== 'ENOENT') {
                        throw error;
                    }
                }
            } else {
                // Auto-generate name
                const sourceBaseName = basename(validation.resolvedPath!);
                const ext = extname(sourceBaseName);
                const nameWithoutExt = ext ? sourceBaseName.slice(0, -ext.length) : sourceBaseName;
                const sourceDir = dirname(validation.resolvedPath!);

                let candidateName = `${nameWithoutExt} copy${ext}`;
                let counter = 2;
                let candidatePath = join(sourceDir, candidateName);

                // Find the first non-existing name
                while (counter <= 100) {
                    try {
                        await stat(candidatePath);
                        // File exists, try next candidate
                        candidateName = ext
                            ? `${nameWithoutExt} copy ${counter}${ext}`
                            : `${nameWithoutExt} copy ${counter}`;
                        candidatePath = join(sourceDir, candidateName);
                        counter++;
                    } catch (error) {
                        const nodeError = error as NodeJS.ErrnoException;
                        if (nodeError.code === 'ENOENT') {
                            // File doesn't exist - use this name
                            break;
                        }
                        throw error;
                    }
                }

                if (counter > 100) {
                    return { success: false, error: 'Failed to find a valid name for the copy' };
                }

                targetName = candidateName;
                targetPath = candidatePath;

                // Validate new path is within working directory
                const newValidation = validatePath(targetPath, workingDirectory);
                if (!newValidation.valid) {
                    return { success: false, error: newValidation.error };
                }
                targetPath = newValidation.resolvedPath!;
            }

            // Perform copy. `errorOnExist` only takes effect when `force` is
            // false (force defaults to true and would silently overwrite), so
            // both are needed to close the gap between the stat check above
            // and the copy itself.
            await cp(validation.resolvedPath!, targetPath, { recursive: true, force: false, errorOnExist: true });
            return { success: true, path: targetPath, name: targetName };
        } catch (error) {
            logger.debug('Failed to copy:', error);
            return { success: false, error: error instanceof Error ? error.message : 'Failed to copy' };
        }
    });

    // Ensure directory exists — creates the target and any missing
    // parents inside the allowed working directory. Idempotent.
    // Used by web-ui to bootstrap a freshly-created project's
    // workspaceDir before the first terminal/upload (see
    // specs/project-workspace-auto-create/).
    rpcHandlerManager.registerHandler<EnsureDirectoryRequest, EnsureDirectoryResponse>('ensureDirectory', async (data) => {
        logger.debug('Ensure directory request:', data.path);
        const result = await ensureDirectory(data.path, workingDirectory);
        return { success: result.success, error: result.error };
    });

    // Get directory tree handler - recursive with depth control
    rpcHandlerManager.registerHandler<GetDirectoryTreeRequest, GetDirectoryTreeResponse>('getDirectoryTree', async (data) => {
        logger.debug('Get directory tree request:', data.path, 'maxDepth:', data.maxDepth);

        // Validate path is within working directory
        const validation = validatePath(data.path, workingDirectory);
        if (!validation.valid) {
            return { success: false, error: validation.error };
        }

        // Helper function to build tree recursively. parentIgnore carries
        // the preset baseline plus any .gitignore layers accumulated from
        // ancestor directories; relPath is the path relative to the walk
        // root — needed so scoped gitignore rules can match correctly.
        async function buildTree(
            path: string,
            name: string,
            currentDepth: number,
            parentIgnore: GitignoreContext,
            relPath: string,
        ): Promise<TreeNode | null> {
            try {
                const stats = await stat(path);

                // Base node information
                const node: TreeNode = {
                    name,
                    path,
                    type: stats.isDirectory() ? 'directory' : 'file',
                    size: stats.size,
                    modified: stats.mtime.getTime()
                };

                // If it's a directory and we haven't reached max depth, get children
                if (stats.isDirectory() && currentDepth < data.maxDepth) {
                    // Layer this directory's .gitignore (if any) on top of the
                    // parent context before scanning children. enterDirectory
                    // returns the same context when there is no .gitignore,
                    // so the common case allocates nothing.
                    const localIgnore = await enterDirectory(parentIgnore, path, relPath);
                    const entries = await readdir(path, { withFileTypes: true });
                    const children: TreeNode[] = [];

                    await Promise.all(
                        entries.map(async (entry) => {
                            // Skip symbolic links completely
                            if (entry.isSymbolicLink()) {
                                logger.debug(`Skipping symlink: ${join(path, entry.name)}`);
                                return;
                            }

                            const childRel = relPath
                                ? `${relPath}/${entry.name}`
                                : entry.name;
                            if (localIgnore.ignores(childRel, entry.isDirectory())) {
                                return;
                            }

                            const childPath = join(path, entry.name);
                            const childNode = await buildTree(
                                childPath,
                                entry.name,
                                currentDepth + 1,
                                localIgnore,
                                childRel,
                            );
                            if (childNode) {
                                children.push(childNode);
                            }
                        })
                    );

                    // Sort children: directories first, then files, alphabetically
                    children.sort((a, b) => {
                        if (a.type === 'directory' && b.type !== 'directory') return -1;
                        if (a.type !== 'directory' && b.type === 'directory') return 1;
                        return a.name.localeCompare(b.name);
                    });

                    node.children = children;
                }

                return node;
            } catch (error) {
                // Log error but continue traversal
                logger.debug(`Failed to process ${path}:`, error instanceof Error ? error.message : String(error));
                return null;
            }
        }

        try {
            // Validate maxDepth
            if (data.maxDepth < 0) {
                return { success: false, error: 'maxDepth must be non-negative' };
            }

            // Get the base name for the root node
            const rootPath = validation.resolvedPath!;
            const baseName = rootPath === '/' ? '/' : rootPath.split('/').pop() || rootPath;
            const tree = await buildTree(rootPath, baseName, 0, baseDirectoryIgnoreContext, '');

            if (!tree) {
                return { success: false, error: 'Failed to access the specified path' };
            }

            return { success: true, tree };
        } catch (error) {
            logger.debug('Failed to get directory tree:', error);
            return { success: false, error: error instanceof Error ? error.message : 'Failed to get directory tree' };
        }
    });

    // Ripgrep handler - raw interface to ripgrep
    rpcHandlerManager.registerHandler<RipgrepRequest, RipgrepResponse>('ripgrep', async (data) => {
        logger.debug('Ripgrep request with args:', data.args, 'cwd:', data.cwd);

        // Validate cwd if provided
        if (data.cwd) {
            const validation = validatePath(data.cwd, workingDirectory);
            if (!validation.valid) {
                return { success: false, error: validation.error };
            }
            data.cwd = validation.resolvedPath;
        }

        try {
            const result = await runRipgrep(data.args, { cwd: data.cwd });
            return {
                success: true,
                exitCode: result.exitCode,
                stdout: result.stdout.toString(),
                stderr: result.stderr.toString()
            };
        } catch (error) {
            logger.debug('Failed to run ripgrep:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to run ripgrep'
            };
        }
    });

    // Difftastic handler - raw interface to difftastic
    rpcHandlerManager.registerHandler<DifftasticRequest, DifftasticResponse>('difftastic', async (data) => {
        logger.debug('Difftastic request with args:', data.args, 'cwd:', data.cwd);

        // Validate cwd if provided
        if (data.cwd) {
            const validation = validatePath(data.cwd, workingDirectory);
            if (!validation.valid) {
                return { success: false, error: validation.error };
            }
            data.cwd = validation.resolvedPath;
        }

        try {
            const result = await runDifftastic(data.args, { cwd: data.cwd });
            return {
                success: true,
                exitCode: result.exitCode,
                stdout: result.stdout.toString(),
                stderr: result.stderr.toString()
            };
        } catch (error) {
            logger.debug('Failed to run difftastic:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to run difftastic'
            };
        }
    });
}
