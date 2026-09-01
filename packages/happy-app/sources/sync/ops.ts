/**
 * Session operations for remote procedure calls
 * Provides strictly typed functions for all session-related RPC operations
 */

import { apiSocket } from './apiSocket';
import { sync } from './sync';
import type { MachineMetadata, Metadata, Session } from './storageTypes';
import { markSessionArchiveRequested, markSessionRestored } from '@/utils/sessionLifecycle';
import { updateEncryptedSessionMetadata } from './sessionMetadata';

export const SESSION_START_RPC_TIMEOUT_MS = 140_000;

// Strict type definitions for all operations

// Permission operation types
interface SessionPermissionRequest {
    id: string;
    approved: boolean;
    reason?: string;
    mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    allowTools?: string[];
    updatedInput?: Record<string, unknown>;
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
}

// Mode change operation types
interface SessionModeChangeRequest {
    to: 'remote' | 'local';
}

interface SessionPermissionModeUpdateRequest {
    mode: string;
}

// Bash operation types
interface SessionBashRequest {
    command: string;
    cwd?: string;
    timeout?: number;
}

interface SessionBashResponse {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
    error?: string;
}

// Read file operation types
interface SessionReadFileRequest {
    path: string;
}

interface SessionReadFileResponse {
    success: boolean;
    content?: string; // base64 encoded
    error?: string;
}

// Write file operation types
interface SessionWriteFileRequest {
    path: string;
    content: string; // base64 encoded
    expectedHash?: string | null;
}

interface SessionWriteFileResponse {
    success: boolean;
    hash?: string;
    error?: string;
}

// List directory operation types
interface SessionListDirectoryRequest {
    path: string;
}

interface DirectoryEntry {
    name: string;
    type: 'file' | 'directory' | 'other';
    size?: number;
    modified?: number;
}

interface SessionListDirectoryResponse {
    success: boolean;
    entries?: DirectoryEntry[];
    error?: string;
}

// Browse directory operation types (new-session path picker)
interface MachineBrowseDirectoryRequest {
    path: string;
}

interface BrowseDirectoryEntry {
    name: string;
    path: string;
    isProjectRoot: boolean;
}

interface MachineBrowseDirectoryResponse {
    success: boolean;
    path?: string;
    parent?: string | null;
    home?: string;
    directories?: BrowseDirectoryEntry[];
    error?: string;
}

// Directory tree operation types
interface SessionGetDirectoryTreeRequest {
    path: string;
    maxDepth: number;
}

interface TreeNode {
    name: string;
    path: string;
    type: 'file' | 'directory';
    size?: number;
    modified?: number;
    children?: TreeNode[];
}

interface SessionGetDirectoryTreeResponse {
    success: boolean;
    tree?: TreeNode;
    error?: string;
}

// Ripgrep operation types
interface SessionRipgrepRequest {
    args: string[];
    cwd?: string;
}

interface SessionRipgrepResponse {
    success: boolean;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    error?: string;
}

// Kill session operation types
interface SessionKillRequest {
    // No parameters needed
}

interface SessionKillResponse {
    success: boolean;
    message: string;
}

interface SessionRegenerateTitleRequest {
    transcript: string;
    currentTitle?: string | null;
    projectPath?: string | null;
    model?: string | null;
    effort?: string | null;
}

export type SessionRegenerateTitleResponse =
    | { success: true; title: string }
    | { success: false; message: string };

// Response types for spawn session
export type SpawnSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'requestToApproveDirectoryCreation'; directory: string }
    | { type: 'error'; errorMessage: string };

function normalizeSpawnSessionResult(result: unknown): SpawnSessionResult {
    if (!result || typeof result !== 'object') {
        return { type: 'error', errorMessage: 'Invalid response while spawning session' };
    }

    const response = result as Record<string, unknown>;
    if (response.type === 'success' && typeof response.sessionId === 'string') {
        return { type: 'success', sessionId: response.sessionId };
    }
    if (response.type === 'requestToApproveDirectoryCreation' && typeof response.directory === 'string') {
        return { type: 'requestToApproveDirectoryCreation', directory: response.directory };
    }
    if (response.type === 'error' && typeof response.errorMessage === 'string') {
        return { type: 'error', errorMessage: response.errorMessage };
    }

    // Older daemon RPC handlers encrypt thrown errors as { error: string }.
    if (typeof response.error === 'string') {
        return { type: 'error', errorMessage: response.error };
    }

    return { type: 'error', errorMessage: 'Invalid response while spawning session' };
}

// Options for spawning a session
export interface SpawnSessionOptions {
    machineId: string;
    directory: string;
    approvedNewDirectoryCreation?: boolean;
    token?: string;
    agent?: 'ask' | 'codex' | 'claude' | 'gemini' | 'opencode' | 'openclaw';
    environmentVariables?: Record<string, string>;
    /**
     * If set, the daemon spawns the agent with `--resume <id>` so the new
     * Happy session attaches to a pre-existing on-disk Claude conversation
     * file. Used by the session fork / duplicate flow.
     */
    resumeClaudeSessionId?: string;
    /**
     * If set, the daemon spawns Codex with `--resume <id>` so the new Happy
     * session attaches to an app-server thread created by fork / duplicate.
     */
    resumeCodexThreadId?: string;
    /** Happy session id this fork was branched from (lineage). */
    parentSessionId?: string;
    /** Happy message id used as the rewind point (only set for "duplicate"). */
    forkedFromMessageId?: string;
}

// Options for forking a Claude session on a machine
export interface ClaudeForkSessionOptions {
    machineId: string;
    /** Working directory of the source session — used to derive the Claude project dir. */
    directory: string;
    /** Optional working directory where the forked transcript should continue. */
    targetDirectory?: string;
    /** Source Claude session UUID (Session.metadata.claudeSessionId on the parent). */
    claudeSessionId: string;
}

export type ClaudeForkSessionResult =
    | { type: 'success'; newClaudeSessionId: string }
    | { type: 'error'; errorMessage: string };

export interface ClaudeRewindPoint {
    uuid: string;
    text: string;
    timestamp: number;
}

export type ClaudeListRewindPointsResult =
    | { type: 'success'; points: ClaudeRewindPoint[] }
    | { type: 'error'; errorMessage: string };

export interface CodexForkThreadOptions {
    machineId: string;
    /** Working directory of the source session, passed to Codex thread/fork. */
    directory: string;
    /** Source Codex app-server thread id (Session.metadata.codexThreadId). */
    codexThreadId: string;
}

export type CodexForkThreadResult =
    | { type: 'success'; newCodexThreadId: string }
    | { type: 'error'; errorMessage: string };

export interface CodexRewindPoint {
    itemId: string;
    text: string;
    timestamp: number;
}

export type CodexListRewindPointsResult =
    | { type: 'success'; points: CodexRewindPoint[] }
    | { type: 'error'; errorMessage: string };

export interface ResumeSessionOptions {
    machineId: string;
    sessionId: string;
}

// Exported session operation functions

/**
 * Spawn a new remote session on a specific machine
 */
export async function machineSpawnNewSession(options: SpawnSessionOptions): Promise<SpawnSessionResult> {

    const { machineId, directory, approvedNewDirectoryCreation = false, token, agent, environmentVariables, resumeClaudeSessionId, resumeCodexThreadId, parentSessionId, forkedFromMessageId } = options;

    try {
        const result = await apiSocket.machineRPC<SpawnSessionResult, {
            type: 'spawn-in-directory'
            directory: string
            approvedNewDirectoryCreation?: boolean,
            token?: string,
            agent?: 'ask' | 'codex' | 'claude' | 'gemini' | 'opencode' | 'openclaw',
            environmentVariables?: Record<string, string>,
            resumeClaudeSessionId?: string,
            resumeCodexThreadId?: string,
            parentSessionId?: string,
            forkedFromMessageId?: string,
        }>(
            machineId,
            'spawn-happy-session',
            { type: 'spawn-in-directory', directory, approvedNewDirectoryCreation, token, agent, environmentVariables, resumeClaudeSessionId, resumeCodexThreadId, parentSessionId, forkedFromMessageId },
            { timeoutMs: SESSION_START_RPC_TIMEOUT_MS },
        );
        return normalizeSpawnSessionResult(result);
    } catch (error) {
        // Handle RPC errors
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to spawn session'
        };
    }
}

/**
 * Copy the source session's Claude JSONL on the daemon machine and return
 * the new Claude session UUID. Caller then spawns a fresh Happy session
 * with `resumeClaudeSessionId` set to that UUID to attach a new Happy
 * session row to the copied conversation.
 */
export async function claudeForkSession(options: ClaudeForkSessionOptions): Promise<ClaudeForkSessionResult> {
    const { machineId, directory, targetDirectory, claudeSessionId } = options;
    try {
        const result = await apiSocket.machineRPC<ClaudeForkSessionResult, {
            directory: string;
            targetDirectory?: string;
            claudeSessionId: string;
        }>(
            machineId,
            'claude-fork-session',
            { directory, targetDirectory, claudeSessionId },
        );
        return result;
    } catch (error) {
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to fork session',
        };
    }
}

/**
 * Read the on-disk Claude JSONL on the daemon machine and return user-text
 * messages with their underlying claudeUuid + timestamp. Disk is the
 * source of truth for the rewind picker — server-side envelopes miss
 * claudeUuid for any user message that travelled via the legacy
 * `sentFrom: 'web'` path.
 */
export async function claudeListRewindPoints(
    options: ClaudeForkSessionOptions,
): Promise<ClaudeListRewindPointsResult> {
    const { machineId, directory, claudeSessionId } = options;
    try {
        const result = await apiSocket.machineRPC<ClaudeListRewindPointsResult, {
            directory: string;
            claudeSessionId: string;
        }>(
            machineId,
            'claude-list-rewind-points',
            { directory, claudeSessionId },
        );
        return result;
    } catch (error) {
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to list rewind points',
        };
    }
}

/**
 * Same as claudeForkSession, but truncates the copied JSONL before the next
 * user prompt after `cutAfterUuid`. The selected user prompt, its agent
 * response, and any tool cycle in that turn remain in the fork. Daemon
 * hard-fails if the UUID isn't present in the source.
 */
export async function claudeDuplicateSession(
    options: ClaudeForkSessionOptions & { cutAfterUuid: string },
): Promise<ClaudeForkSessionResult> {
    const { machineId, directory, claudeSessionId, cutAfterUuid } = options;
    try {
        const result = await apiSocket.machineRPC<ClaudeForkSessionResult, {
            directory: string;
            claudeSessionId: string;
            cutAfterUuid: string;
        }>(
            machineId,
            'claude-duplicate-session',
            { directory, claudeSessionId, cutAfterUuid },
        );
        return result;
    } catch (error) {
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to duplicate session',
        };
    }
}

export async function codexForkThread(options: CodexForkThreadOptions): Promise<CodexForkThreadResult> {
    const { machineId, directory, codexThreadId } = options;
    try {
        const result = await apiSocket.machineRPC<CodexForkThreadResult, {
            directory: string;
            codexThreadId: string;
        }>(
            machineId,
            'codex-fork-thread',
            { directory, codexThreadId },
        );
        return result;
    } catch (error) {
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to fork Codex thread',
        };
    }
}

export async function codexDuplicateThread(
    options: CodexForkThreadOptions & { cutAfterItemId: string; retainSelectedTurn?: boolean },
): Promise<CodexForkThreadResult> {
    const { machineId, directory, codexThreadId, cutAfterItemId, retainSelectedTurn } = options;
    try {
        const result = await apiSocket.machineRPC<CodexForkThreadResult, {
            directory: string;
            codexThreadId: string;
            cutAfterItemId: string;
            retainSelectedTurn?: boolean;
        }>(
            machineId,
            'codex-duplicate-thread',
            {
                directory,
                codexThreadId,
                cutAfterItemId,
                ...(retainSelectedTurn ? { retainSelectedTurn: true } : {}),
            },
        );
        return result;
    } catch (error) {
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to duplicate Codex thread',
        };
    }
}

export async function codexListRewindPoints(
    options: CodexForkThreadOptions,
): Promise<CodexListRewindPointsResult> {
    const { machineId, directory, codexThreadId } = options;
    try {
        const result = await apiSocket.machineRPC<CodexListRewindPointsResult, {
            directory: string;
            codexThreadId: string;
        }>(
            machineId,
            'codex-list-rewind-points',
            { directory, codexThreadId },
        );
        return result;
    } catch (error) {
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to list Codex rewind points',
        };
    }
}

export async function machineResumeSession(
    options: ResumeSessionOptions & { model?: string; permissionMode?: string; effort?: string | null },
): Promise<SpawnSessionResult> {
    const { machineId, sessionId, model, permissionMode, effort } = options;

    try {
        const result = await apiSocket.machineRPC<SpawnSessionResult, { sessionId: string; model?: string; permissionMode?: string; effort?: string | null }>(
            machineId,
            'resume-happy-session',
            { sessionId, model, permissionMode, effort },
            { timeoutMs: SESSION_START_RPC_TIMEOUT_MS },
        );
        return normalizeSpawnSessionResult(result);
    } catch (error) {
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to resume session',
        };
    }
}

/**
 * Permanently remove a machine from the server. Sessions spawned by the
 * machine are preserved; only the Machine row and its AccessKeys are deleted.
 */
export async function machineDelete(machineId: string): Promise<{ success: boolean; message?: string }> {
    try {
        const response = await apiSocket.request(`/v1/machines/${machineId}`, {
            method: 'DELETE'
        });
        if (response.ok) {
            return { success: true };
        }
        const error = await response.text();
        return { success: false, message: error || 'Failed to delete machine' };
    } catch (error) {
        return {
            success: false,
            message: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Stop the daemon on a specific machine
 */
export async function machineStopDaemon(machineId: string): Promise<{ message: string }> {
    const result = await apiSocket.machineRPC<{ message: string }, {}>(
        machineId,
        'stop-daemon',
        {}
    );
    return result;
}

/**
 * Execute a bash command on a specific machine (machine-level handler, no active session needed).
 * Accepts a SessionBashRequest so callers can optionally pass cwd / timeout.
 */
export async function machineBash(machineId: string, request: SessionBashRequest): Promise<SessionBashResponse> {
    try {
        return await apiSocket.machineRPC<SessionBashResponse, SessionBashRequest>(machineId, 'bash', request);
    } catch (error) {
        return {
            success: false,
            stdout: '',
            stderr: error instanceof Error ? error.message : 'Unknown error',
            exitCode: -1,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Update machine metadata with optimistic concurrency control and automatic retry
 */
export async function machineUpdateMetadata(
    machineId: string,
    metadata: MachineMetadata,
    expectedVersion: number,
    maxRetries: number = 3
): Promise<{ version: number; metadata: string }> {
    let currentVersion = expectedVersion;
    let currentMetadata = { ...metadata };
    let retryCount = 0;

    const machineEncryption = sync.encryption.getMachineEncryption(machineId);
    if (!machineEncryption) {
        throw new Error(`Machine encryption not found for ${machineId}`);
    }

    while (retryCount < maxRetries) {
        const encryptedMetadata = await machineEncryption.encryptRaw(currentMetadata);

        const result = await apiSocket.emitWithAck<{
            result: 'success' | 'version-mismatch' | 'error';
            version?: number;
            metadata?: string;
            message?: string;
        }>('machine-update-metadata', {
            machineId,
            metadata: encryptedMetadata,
            expectedVersion: currentVersion
        });

        if (result.result === 'success') {
            return {
                version: result.version!,
                metadata: result.metadata!
            };
        } else if (result.result === 'version-mismatch') {
            // Get the latest version and metadata from the response
            currentVersion = result.version!;
            const latestMetadata = await machineEncryption.decryptRaw(result.metadata!) as MachineMetadata;

            // Merge our changes with the latest metadata
            // Preserve the displayName we're trying to set, but use latest values for other fields
            currentMetadata = {
                ...latestMetadata,
                displayName: metadata.displayName // Keep our intended displayName change
            };

            retryCount++;

            // If we've exhausted retries, throw error
            if (retryCount >= maxRetries) {
                throw new Error(`Failed to update after ${maxRetries} retries due to version conflicts`);
            }

            // Otherwise, loop will retry with updated version and merged metadata
        } else {
            throw new Error(result.message || 'Failed to update machine metadata');
        }
    }

    throw new Error('Unexpected error in machineUpdateMetadata');
}

export async function sessionUpdateMetadata(
    sessionId: string,
    metadata: Metadata,
    expectedVersion: number,
    update: (metadata: Metadata) => Metadata,
    maxRetries: number = 3,
): Promise<{ version: number; metadata: Metadata }> {
    const sessionEncryption = sync.encryption.getSessionEncryption(sessionId);
    if (!sessionEncryption) {
        throw new Error(`Session encryption not found for ${sessionId}`);
    }
    return updateEncryptedSessionMetadata(
        sessionId,
        metadata,
        expectedVersion,
        sessionEncryption,
        update,
        maxRetries,
    );
}

export async function sessionRequestArchiveMetadata(
    session: Pick<Session, 'id' | 'metadata' | 'metadataVersion'>,
): Promise<{ version: number; metadata: Metadata }> {
    if (!session.metadata) {
        throw new Error('Session metadata is unavailable');
    }
    return sessionUpdateMetadata(
        session.id,
        session.metadata,
        session.metadataVersion,
        metadata => markSessionArchiveRequested(metadata, Date.now()),
    );
}

export async function sessionRestoreMetadata(
    session: Pick<Session, 'id' | 'metadata' | 'metadataVersion'>,
): Promise<{ version: number; metadata: Metadata }> {
    if (!session.metadata) {
        throw new Error('Session metadata is unavailable');
    }
    return sessionUpdateMetadata(
        session.id,
        session.metadata,
        session.metadataVersion,
        metadata => markSessionRestored(metadata, Date.now()),
    );
}

/**
 * Abort the current session operation
 */
export async function sessionAbort(sessionId: string): Promise<void> {
    await apiSocket.sessionRPC(sessionId, 'abort', {
        reason: `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.`
    });
}

/**
 * Allow a permission request
 */
export async function sessionAllow(sessionId: string, id: string, mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan', allowedTools?: string[], decision?: 'approved' | 'approved_for_session', updatedInput?: Record<string, unknown>): Promise<void> {
    const request: SessionPermissionRequest = { id, approved: true, mode, allowTools: allowedTools, decision, updatedInput };
    await apiSocket.sessionRPC(sessionId, 'permission', request);
}

/**
 * Deny a permission request
 */
export async function sessionDeny(sessionId: string, id: string, mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan', allowedTools?: string[], decision?: 'denied' | 'abort'): Promise<void> {
    const request: SessionPermissionRequest = { id, approved: false, mode, allowTools: allowedTools, decision };
    await apiSocket.sessionRPC(sessionId, 'permission', request);
}

/**
 * Request mode change for a session
 */
export async function sessionSwitch(sessionId: string, to: 'remote' | 'local'): Promise<boolean> {
    const request: SessionModeChangeRequest = { to };
    const response = await apiSocket.sessionRPC<boolean, SessionModeChangeRequest>(
        sessionId,
        'switch',
        request,
    );
    return response;
}

/**
 * Push a permission-mode change to the running session immediately.
 * Future turns still carry the same mode via normal message meta.
 */
export async function sessionSetPermissionMode(sessionId: string, mode: string): Promise<boolean> {
    const request: SessionPermissionModeUpdateRequest = { mode };
    return await apiSocket.sessionRPC<boolean, SessionPermissionModeUpdateRequest>(
        sessionId,
        'setPermissionMode',
        request,
    );
}

/**
 * Execute a bash command in the session
 */
export async function sessionBash(sessionId: string, request: SessionBashRequest): Promise<SessionBashResponse> {
    try {
        const response = await apiSocket.sessionRPC<SessionBashResponse, SessionBashRequest>(
            sessionId,
            'bash',
            request
        );
        return response;
    } catch (error) {
        return {
            success: false,
            stdout: '',
            stderr: error instanceof Error ? error.message : 'Unknown error',
            exitCode: -1,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Read a file from the session
 */
export async function sessionReadFile(sessionId: string, path: string): Promise<SessionReadFileResponse> {
    try {
        const request: SessionReadFileRequest = { path };
        const response = await apiSocket.sessionRPC<SessionReadFileResponse, SessionReadFileRequest>(
            sessionId,
            'readFile',
            request
        );
        return response;
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Write a file to the session
 */
export async function sessionWriteFile(
    sessionId: string,
    path: string,
    content: string,
    expectedHash?: string | null
): Promise<SessionWriteFileResponse> {
    try {
        const request: SessionWriteFileRequest = { path, content, expectedHash };
        const response = await apiSocket.sessionRPC<SessionWriteFileResponse, SessionWriteFileRequest>(
            sessionId,
            'writeFile',
            request
        );
        return response;
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * List directory contents in the session
 */
export async function sessionListDirectory(sessionId: string, path: string): Promise<SessionListDirectoryResponse> {
    try {
        const request: SessionListDirectoryRequest = { path };
        const response = await apiSocket.sessionRPC<SessionListDirectoryResponse, SessionListDirectoryRequest>(
            sessionId,
            'listDirectory',
            request
        );
        return response;
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Browse directories on a machine for the new-session path picker.
 *
 * Routes the daemon `browseDirectory` RPC at the machine level (no session
 * exists yet when picking a working directory). The daemon roots browsing at
 * the user's home directory and returns only sub-directories plus navigation
 * context (resolved path / parent / home), so the UI can render a point-and-
 * click breadcrumb browser without any local path math.
 *
 * Passing an empty path lands on the home directory.
 */
export async function machineBrowseDirectory(machineId: string, path: string): Promise<MachineBrowseDirectoryResponse> {
    try {
        const response = await apiSocket.machineRPC<MachineBrowseDirectoryResponse, MachineBrowseDirectoryRequest>(
            machineId,
            'browseDirectory',
            { path }
        );
        return response;
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Get directory tree from the session
 */
export async function sessionGetDirectoryTree(
    sessionId: string,
    path: string,
    maxDepth: number
): Promise<SessionGetDirectoryTreeResponse> {
    try {
        const request: SessionGetDirectoryTreeRequest = { path, maxDepth };
        const response = await apiSocket.sessionRPC<SessionGetDirectoryTreeResponse, SessionGetDirectoryTreeRequest>(
            sessionId,
            'getDirectoryTree',
            request
        );
        return response;
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Run ripgrep in the session
 */
export async function sessionRipgrep(
    sessionId: string,
    args: string[],
    cwd?: string
): Promise<SessionRipgrepResponse> {
    try {
        const request: SessionRipgrepRequest = { args, cwd };
        const response = await apiSocket.sessionRPC<SessionRipgrepResponse, SessionRipgrepRequest>(
            sessionId,
            'ripgrep',
            request
        );
        return response;
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/**
 * Kill the session process immediately
 */
export async function sessionKill(sessionId: string): Promise<SessionKillResponse> {
    try {
        const response = await apiSocket.sessionRPC<SessionKillResponse, {}>(
            sessionId,
            'killSession',
            {}
        );
        return response;
    } catch (error) {
        return {
            success: false,
            message: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

export async function sessionRegenerateTitle(
    sessionId: string,
    request: SessionRegenerateTitleRequest,
): Promise<SessionRegenerateTitleResponse> {
    try {
        return await apiSocket.sessionRPC<SessionRegenerateTitleResponse, SessionRegenerateTitleRequest>(
            sessionId,
            'regenerateTitle',
            request,
        );
    } catch (error) {
        return {
            success: false,
            message: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}

/**
 * Deactivate transport presence after encrypted lifecycle metadata has marked
 * the session archived. Use when the CLI is already dead and cannot report its
 * own shutdown; this endpoint never owns archive-list membership.
 */
export async function sessionArchive(sessionId: string): Promise<{ success: boolean; message?: string }> {
    try {
        const response = await apiSocket.request(`/v1/sessions/${sessionId}/archive`, {
            method: 'POST'
        });
        if (!response.ok) {
            return { success: false, message: `Server error: ${response.status}` };
        }
        return { success: true };
    } catch (error) {
        return { success: false, message: error instanceof Error ? error.message : 'Unknown error' };
    }
}

/**
 * Permanently delete a session from the server
 * This will remove the session and all its associated data (messages, usage reports, access keys)
 * The session should be inactive/archived before deletion
 */
export async function sessionDelete(sessionId: string): Promise<{ success: boolean; message?: string }> {
    try {
        const response = await apiSocket.request(`/v1/sessions/${sessionId}`, {
            method: 'DELETE'
        });
        
        if (response.ok) {
            const result = await response.json();
            return { success: true };
        } else if (response.status === 404) {
            return { success: true };
        } else {
            const error = await response.text();
            return {
                success: false,
                message: error || 'Failed to delete session'
            };
        }
    } catch (error) {
        return {
            success: false,
            message: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

type ClaudeForkSource = {
    kind?: 'claude';
    sessionId: string;
    machineId: string;
    directory: string;
    claudeSessionId: string;
};

type CodexForkSource = {
    kind: 'codex';
    sessionId: string;
    machineId: string;
    directory: string;
    codexThreadId: string;
};

// Forking source description used by forkAndSpawn.
export type ForkSource = ClaudeForkSource | CodexForkSource;

type ForkOptions = {
    cutAfterUuid?: string;
    cutAfterItemId?: string;
    forkedFromMessageId?: string;
    retainSelectedTurn?: boolean;
    /** Continue the fork in a different validated working directory. */
    targetDirectory?: string;
};

async function hydrateSpawnedSession(sessionId: string): Promise<void> {
    try {
        const hydrated = await sync.refreshSession(sessionId);
        if (!hydrated) {
            await sync.refreshSessions();
        }
    } catch {
        // Hydration is best-effort; the new-session broadcast will still
        // populate local state if either fetch path flakes.
    }
}

/**
 * Two-step orchestrator for the session fork / duplicate flow:
 *   1. Ask the daemon to copy (and optionally truncate) the source Claude
 *      JSONL — returns a fresh Claude session UUID.
 *   2. Spawn a new Happy session on the same machine with
 *      `resumeClaudeSessionId` set to that UUID so `claude --resume` picks
 *      up the copied conversation.
 *
 * Lineage (parentSessionId, forkedFromMessageId) rides through the spawn
 * RPC into env vars, then into the new Happy session's metadata at start
 * — so the parent link survives without any server-side schema change.
 */
export async function forkAndSpawn(
    source: ForkSource,
    opts: ForkOptions = {},
): Promise<SpawnSessionResult> {
    const spawnDirectory = opts.targetDirectory ?? source.directory;
    if (source.kind === 'codex') {
        const forkResult = opts.cutAfterItemId
            ? await codexDuplicateThread({
                machineId: source.machineId,
                directory: spawnDirectory,
                codexThreadId: source.codexThreadId,
                cutAfterItemId: opts.cutAfterItemId,
                retainSelectedTurn: opts.retainSelectedTurn,
            })
            : await codexForkThread({
                machineId: source.machineId,
                directory: spawnDirectory,
                codexThreadId: source.codexThreadId,
            });

        if (forkResult.type !== 'success') {
            return { type: 'error', errorMessage: forkResult.errorMessage };
        }

        const spawnResult = await machineSpawnNewSession({
            machineId: source.machineId,
            directory: spawnDirectory,
            agent: 'codex',
            approvedNewDirectoryCreation: false,
            resumeCodexThreadId: forkResult.newCodexThreadId,
            parentSessionId: source.sessionId,
            forkedFromMessageId: opts.forkedFromMessageId,
        });

        if (spawnResult.type === 'success') {
            await hydrateSpawnedSession(spawnResult.sessionId);
        }

        return spawnResult;
    }

    const forkResult = opts.cutAfterUuid
        ? await claudeDuplicateSession({
            machineId: source.machineId,
            directory: source.directory,
            claudeSessionId: source.claudeSessionId,
            cutAfterUuid: opts.cutAfterUuid,
        })
        : await claudeForkSession({
            machineId: source.machineId,
            directory: source.directory,
            targetDirectory: spawnDirectory,
            claudeSessionId: source.claudeSessionId,
        });

    if (forkResult.type !== 'success') {
        return { type: 'error', errorMessage: forkResult.errorMessage };
    }

    const spawnResult = await machineSpawnNewSession({
        machineId: source.machineId,
        directory: spawnDirectory,
        agent: 'claude',
        approvedNewDirectoryCreation: false,
        resumeClaudeSessionId: forkResult.newClaudeSessionId,
        parentSessionId: source.sessionId,
        forkedFromMessageId: opts.forkedFromMessageId,
    });

    // Pull only the newly-created session row into local sync state before we
    // hand control back to the caller. A full account refresh can decrypt up
    // to 150 sessions and may be queued twice by the concurrent broadcast,
    // unnecessarily blocking navigation after the fork already succeeded.
    if (spawnResult.type === 'success') {
        await hydrateSpawnedSession(spawnResult.sessionId);
    }

    return spawnResult;
}

// Export types for external use
export type {
    SessionBashRequest,
    SessionBashResponse,
    SessionReadFileResponse,
    SessionWriteFileResponse,
    SessionListDirectoryResponse,
    DirectoryEntry,
    MachineBrowseDirectoryResponse,
    BrowseDirectoryEntry,
    SessionGetDirectoryTreeResponse,
    TreeNode,
    SessionRipgrepResponse,
    SessionKillResponse
};
