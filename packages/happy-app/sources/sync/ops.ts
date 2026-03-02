/**
 * Session operations for remote procedure calls
 * Provides strictly typed functions for all session-related RPC operations
 */

import { apiSocket } from './apiSocket';
import { sync } from './sync';
import type { MachineMetadata, Metadata } from './storageTypes';

// Strict type definitions for all operations

// Permission operation types
interface SessionPermissionRequest {
    id: string;
    approved: boolean;
    reason?: string;
    mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    allowTools?: string[];
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
    answers?: Record<string, string>;
}

// Mode change operation types
interface SessionModeChangeRequest {
    to: 'remote' | 'local';
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

// Response types for spawn session
export type SpawnSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'requestToApproveDirectoryCreation'; directory: string }
    | { type: 'error'; errorMessage: string };

// Options for spawning a session
export interface SpawnSessionOptions {
    machineId: string;
    directory: string;
    approvedNewDirectoryCreation?: boolean;
    token?: string;
    agent?: 'codex' | 'claude' | 'gemini';
    resumeSessionId?: string;
    sessionTitle?: string;
    skipForkSession?: boolean;
    // Environment variables from AI backend profile
    // Accepts any environment variables - daemon will pass them to the agent process
    // Common variables include:
    // - ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_MODEL, ANTHROPIC_SMALL_FAST_MODEL
    // - OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL, OPENAI_API_TIMEOUT_MS
    // - AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_VERSION, AZURE_OPENAI_DEPLOYMENT_NAME
    // - TOGETHER_API_KEY, TOGETHER_MODEL
    // - TMUX_SESSION_NAME, TMUX_TMPDIR, TMUX_UPDATE_ENVIRONMENT
    // - API_TIMEOUT_MS, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
    // - Custom variables (DEEPSEEK_*, Z_AI_*, etc.)
    environmentVariables?: Record<string, string>;
    // Worktree metadata - passed to CLI so it's included in initial metadata (avoids race condition)
    worktreeBasePath?: string;
    worktreeBranchName?: string;
    // Extra MCP servers to inject (e.g., DooTask MCP)
    mcpServers?: Array<{
        name: string;
        url: string;
        headers?: Record<string, string>;
    }>;
    // Multi-repo workspace
    workspaceRepos?: Array<{
        repoId?: string;
        path: string;
        basePath: string;
        branchName: string;
        targetBranch?: string;
        displayName?: string;
    }>;
    workspacePath?: string;
    repoScripts?: Array<{
        repoDisplayName: string;
        worktreePath: string;
        setupScript?: string;
        parallelSetup?: boolean;
        cleanupScript?: string;
        archiveScript?: string;
        devServerScript?: string;
    }>;
}

export interface ClaudeSessionIndexEntry {
    sessionId: string;
    projectId: string;
    originalPath: string | null;
    title?: string | null;
    updatedAt?: number;
    messageCount?: number;
    gitBranch?: string | null;
}

export interface ClaudeSessionPreviewMessage {
    role: 'user' | 'assistant';
    content: string;
    timestamp?: string;
}

export interface UserMessageWithUuid {
    uuid: string;
    content: string;
    timestamp?: string;
    index: number;
}

/** @deprecated Use UserMessageWithUuid instead */
export type ClaudeUserMessageWithUuid = UserMessageWithUuid;

/** Unified session entry type for multi-agent history browser */
export interface AgentSessionIndexEntry {
    sessionId: string;
    agent: 'claude' | 'gemini' | 'codex';
    originalPath: string | null;
    title?: string | null;
    updatedAt?: number;
    messageCount?: number;
    gitBranch?: string | null;
    projectId?: string; // Claude only
}

/** Agent-agnostic alias for preview messages */
export type SessionPreviewMessage = ClaudeSessionPreviewMessage;

// Exported session operation functions

/**
 * Spawn a new remote session on a specific machine
 */
export async function machineSpawnNewSession(options: SpawnSessionOptions): Promise<SpawnSessionResult> {

    const { machineId, directory, approvedNewDirectoryCreation = false, token, agent, resumeSessionId, sessionTitle, skipForkSession, environmentVariables, worktreeBasePath, worktreeBranchName, mcpServers, workspaceRepos, workspacePath, repoScripts } = options;

    try {
        const result = await apiSocket.machineRPC<SpawnSessionResult, {
            type: 'spawn-in-directory'
            directory: string
            approvedNewDirectoryCreation?: boolean,
            token?: string,
            agent?: 'codex' | 'claude' | 'gemini',
            resumeSessionId?: string,
            sessionTitle?: string,
            skipForkSession?: boolean,
            environmentVariables?: Record<string, string>;
            worktreeBasePath?: string,
            worktreeBranchName?: string,
            mcpServers?: Array<{ name: string; url: string; headers?: Record<string, string> }>,
            workspaceRepos?: Array<{ repoId?: string; path: string; basePath: string; branchName: string; targetBranch?: string; displayName?: string }>,
            workspacePath?: string,
            repoScripts?: Array<{ repoDisplayName: string; worktreePath: string; setupScript?: string; parallelSetup?: boolean; cleanupScript?: string; archiveScript?: string; devServerScript?: string }>,
        }>(
            machineId,
            'spawn-happy-session',
            { type: 'spawn-in-directory', directory, approvedNewDirectoryCreation, token, agent, resumeSessionId, sessionTitle, skipForkSession, environmentVariables, worktreeBasePath, worktreeBranchName, mcpServers, workspaceRepos, workspacePath, repoScripts }
        );
        return result;
    } catch (error) {
        // Handle RPC errors
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to spawn session'
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
 * List Claude sessions from local Claude index on a machine
 */
export async function machineListClaudeSessions(
    machineId: string,
    options?: { offset?: number; limit?: number; query?: string; waitForRefresh?: boolean; timeoutMs?: number }
): Promise<{ sessions: ClaudeSessionIndexEntry[]; total: number; fromCache?: boolean }> {
    const timeoutMs = options?.timeoutMs ?? 10000;

    const rpcPromise = apiSocket.machineRPC<any, { offset?: number; limit?: number; query?: string; waitForRefresh?: boolean }>(
        machineId,
        'claude-list-sessions',
        {
            offset: options?.offset,
            limit: options?.limit,
            query: options?.query,
            waitForRefresh: options?.waitForRefresh,
        }
    );

    const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Request timed out')), timeoutMs);
    });

    const result = await Promise.race([rpcPromise, timeoutPromise]);

    if (!result) {
        throw new Error('RPC returned empty response');
    }
    if (result.error) {
        throw new Error(result.error);
    }
    if (!Array.isArray(result.sessions)) {
        return { sessions: [], total: 0 };
    }
    const total = typeof result.total === 'number' ? result.total : result.sessions.length;
    return { sessions: result.sessions, total, fromCache: result.fromCache };
}

/**
 * Get preview messages from a Claude session
 */
export async function machineGetClaudeSessionPreview(
    machineId: string,
    projectId: string,
    sessionId: string,
    options?: { limit?: number; timeoutMs?: number }
): Promise<{ messages: ClaudeSessionPreviewMessage[] }> {
    const timeoutMs = options?.timeoutMs ?? 10000;
    const limit = options?.limit ?? 10;

    const rpcPromise = apiSocket.machineRPC<any, { projectId: string; sessionId: string; limit: number }>(
        machineId,
        'claude-session-preview',
        { projectId, sessionId, limit }
    );

    const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Request timed out')), timeoutMs);
    });

    const result = await Promise.race([rpcPromise, timeoutPromise]);

    if (!result) {
        throw new Error('RPC returned empty response');
    }
    if (result.error) {
        throw new Error(result.error);
    }
    if (!Array.isArray(result.messages)) {
        return { messages: [] };
    }
    return { messages: result.messages };
}

/**
 * List Gemini sessions from a machine
 */
export async function machineListGeminiSessions(
    machineId: string,
    options?: { offset?: number; limit?: number; query?: string; waitForRefresh?: boolean; timeoutMs?: number }
): Promise<{ sessions: AgentSessionIndexEntry[]; total: number; fromCache?: boolean }> {
    const timeoutMs = options?.timeoutMs ?? 15000;

    const rpcPromise = apiSocket.machineRPC<any, { offset?: number; limit?: number; query?: string; waitForRefresh?: boolean }>(
        machineId,
        'gemini-list-sessions',
        {
            offset: options?.offset,
            limit: options?.limit,
            query: options?.query,
            waitForRefresh: options?.waitForRefresh,
        }
    );

    const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Request timed out')), timeoutMs);
    });

    const result = await Promise.race([rpcPromise, timeoutPromise]);

    if (!result) throw new Error('RPC returned empty response');
    if (result.error) throw new Error(result.error);
    if (!Array.isArray(result.sessions)) return { sessions: [], total: 0 };

    const sessions: AgentSessionIndexEntry[] = result.sessions.map((s: any) => ({
        ...s,
        agent: 'gemini' as const,
    }));
    const total = typeof result.total === 'number' ? result.total : sessions.length;
    return { sessions, total, fromCache: result.fromCache };
}

/**
 * Get preview messages from a Gemini session
 */
export async function machineGetGeminiSessionPreview(
    machineId: string,
    sessionId: string,
    options?: { limit?: number; timeoutMs?: number }
): Promise<{ messages: SessionPreviewMessage[] }> {
    const timeoutMs = options?.timeoutMs ?? 10000;
    const limit = options?.limit ?? 10;

    const rpcPromise = apiSocket.machineRPC<any, { sessionId: string; limit: number }>(
        machineId,
        'gemini-session-preview',
        { sessionId, limit }
    );

    const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Request timed out')), timeoutMs);
    });

    const result = await Promise.race([rpcPromise, timeoutPromise]);

    if (!result) throw new Error('RPC returned empty response');
    if (result.error) throw new Error(result.error);
    return { messages: Array.isArray(result.messages) ? result.messages : [] };
}

/**
 * List Codex sessions from a machine
 */
export async function machineListCodexSessions(
    machineId: string,
    options?: { offset?: number; limit?: number; query?: string; waitForRefresh?: boolean; timeoutMs?: number }
): Promise<{ sessions: AgentSessionIndexEntry[]; total: number; fromCache?: boolean }> {
    const timeoutMs = options?.timeoutMs ?? 15000;

    const rpcPromise = apiSocket.machineRPC<any, { offset?: number; limit?: number; query?: string; waitForRefresh?: boolean }>(
        machineId,
        'codex-list-sessions',
        {
            offset: options?.offset,
            limit: options?.limit,
            query: options?.query,
            waitForRefresh: options?.waitForRefresh,
        }
    );

    const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Request timed out')), timeoutMs);
    });

    const result = await Promise.race([rpcPromise, timeoutPromise]);

    if (!result) throw new Error('RPC returned empty response');
    if (result.error) throw new Error(result.error);
    if (!Array.isArray(result.sessions)) return { sessions: [], total: 0 };

    const sessions: AgentSessionIndexEntry[] = result.sessions.map((s: any) => ({
        ...s,
        agent: 'codex' as const,
    }));
    const total = typeof result.total === 'number' ? result.total : sessions.length;
    return { sessions, total, fromCache: result.fromCache };
}

/**
 * Get preview messages from a Codex session
 */
export async function machineGetCodexSessionPreview(
    machineId: string,
    codexSessionId: string,
    options?: { limit?: number; timeoutMs?: number }
): Promise<{ messages: SessionPreviewMessage[] }> {
    const timeoutMs = options?.timeoutMs ?? 10000;
    const limit = options?.limit ?? 10;

    const rpcPromise = apiSocket.machineRPC<any, { codexSessionId: string; limit: number }>(
        machineId,
        'codex-session-preview',
        { codexSessionId, limit }
    );

    const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Request timed out')), timeoutMs);
    });

    const result = await Promise.race([rpcPromise, timeoutPromise]);

    if (!result) throw new Error('RPC returned empty response');
    if (result.error) throw new Error(result.error);
    return { messages: Array.isArray(result.messages) ? result.messages : [] };
}

/**
 * Execute a bash command on a specific machine
 */
export async function machineBash(
    machineId: string,
    command: string,
    cwd: string
): Promise<{
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
}> {
    try {
        const result = await apiSocket.machineRPC<{
            success: boolean;
            stdout: string;
            stderr: string;
            exitCode: number;
        }, {
            command: string;
            cwd: string;
        }>(
            machineId,
            'bash',
            { command, cwd }
        );
        return result;
    } catch (error) {
        return {
            success: false,
            stdout: '',
            stderr: error instanceof Error ? error.message : 'Unknown error',
            exitCode: -1
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

/**
 * Update session summary (title) by updating session metadata
 */
export async function sessionUpdateSummary(
    sessionId: string,
    currentMetadata: Metadata,
    newSummaryText: string,
    expectedVersion: number,
    pinned?: boolean,
    maxRetries: number = 3
): Promise<{ version: number }> {
    let currentVersion = expectedVersion;

    const sessionEncryption = sync.encryption.getSessionEncryption(sessionId);
    if (!sessionEncryption) {
        throw new Error(`Session encryption not found for ${sessionId}`);
    }

    let metadataToSend: Metadata = {
        ...currentMetadata,
        summary: {
            text: newSummaryText,
            updatedAt: Date.now()
        },
        summaryPinned: pinned
    };

    for (let retryCount = 0; retryCount < maxRetries; retryCount++) {
        const encryptedMetadata = await sessionEncryption.encryptRaw(metadataToSend);

        const result = await apiSocket.emitWithAck<{
            result: 'success' | 'version-mismatch' | 'error';
            version?: number;
            metadata?: string;
            message?: string;
        }>('update-metadata', {
            sid: sessionId,
            metadata: encryptedMetadata,
            expectedVersion: currentVersion
        });

        if (result.result === 'success') {
            return { version: result.version! };
        } else if (result.result === 'version-mismatch') {
            currentVersion = result.version!;
            // Decrypt latest metadata and re-apply our summary change
            const latestMetadata = await sessionEncryption.decryptRaw(result.metadata!) as Metadata;
            metadataToSend = {
                ...latestMetadata,
                summary: {
                    text: newSummaryText,
                    updatedAt: Date.now()
                },
                summaryPinned: pinned
            };
        } else {
            throw new Error(result.message || 'Failed to update session metadata');
        }
    }

    throw new Error(`Failed to update after ${maxRetries} retries due to version conflicts`);
}

/**
 * Update arbitrary metadata fields on a session (with encryption and version-conflict retry)
 */
export async function sessionUpdateMetadataFields(
    sessionId: string,
    currentMetadata: Metadata,
    updates: Partial<Metadata>,
    expectedVersion: number,
    maxRetries: number = 3
): Promise<{ version: number }> {
    let currentVersion = expectedVersion;

    const sessionEncryption = sync.encryption.getSessionEncryption(sessionId);
    if (!sessionEncryption) {
        throw new Error(`Session encryption not found for ${sessionId}`);
    }

    let metadataToSend: Metadata = { ...currentMetadata, ...updates };

    for (let retryCount = 0; retryCount < maxRetries; retryCount++) {
        const encryptedMetadata = await sessionEncryption.encryptRaw(metadataToSend);

        const result = await apiSocket.emitWithAck<{
            result: 'success' | 'version-mismatch' | 'error';
            version?: number;
            metadata?: string;
            message?: string;
        }>('update-metadata', {
            sid: sessionId,
            metadata: encryptedMetadata,
            expectedVersion: currentVersion
        });

        if (result.result === 'success') {
            return { version: result.version! };
        } else if (result.result === 'version-mismatch') {
            currentVersion = result.version!;
            const latestMetadata = await sessionEncryption.decryptRaw(result.metadata!) as Metadata;
            metadataToSend = { ...latestMetadata, ...updates };
        } else {
            throw new Error(result.message || 'Failed to update session metadata');
        }
    }

    throw new Error(`Failed to update after ${maxRetries} retries due to version conflicts`);
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
export async function sessionAllow(sessionId: string, id: string, mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan', allowedTools?: string[], decision?: 'approved' | 'approved_for_session', answers?: Record<string, string>): Promise<void> {
    const request: SessionPermissionRequest = { id, approved: true, mode, allowTools: allowedTools, decision, answers };
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
 * Execute a bash command in the session
 */
export async function sessionBash(sessionId: string, request: SessionBashRequest): Promise<SessionBashResponse> {
    try {
        // RPC timeout = command timeout + 5s buffer for network round-trip
        const rpcTimeout = (request.timeout || 30000) + 5000;
        const response = await apiSocket.sessionRPC<SessionBashResponse, SessionBashRequest>(
            sessionId,
            'bash',
            request,
            rpcTimeout
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

/**
 * Get user messages with UUIDs from a Claude session
 * Used for the duplicate/fork feature to let users select a point to fork from
 */
export async function machineGetClaudeSessionUserMessages(
    machineId: string,
    claudeSessionId: string,
    options?: { limit?: number; timeoutMs?: number }
): Promise<{ messages: ClaudeUserMessageWithUuid[]; projectId: string }> {
    const timeoutMs = options?.timeoutMs ?? 15000;
    const limit = options?.limit ?? 50;

    const rpcPromise = apiSocket.machineRPC<any, { sessionId: string; limit: number }>(
        machineId,
        'claude-session-user-messages',
        { sessionId: claudeSessionId, limit }
    );

    const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Request timed out')), timeoutMs);
    });

    const result = await Promise.race([rpcPromise, timeoutPromise]);

    if (!result) {
        throw new Error('RPC returned empty response');
    }
    if (result.error) {
        throw new Error(result.error);
    }
    if (!Array.isArray(result.messages)) {
        return { messages: [], projectId: result.projectId || '' };
    }
    return { messages: result.messages, projectId: result.projectId };
}

/**
 * Duplicate (fork and truncate) a Claude session
 * Creates a new session that is a copy of the original up to the specified point
 */
export async function machineDuplicateClaudeSession(
    machineId: string,
    claudeSessionId: string,
    truncateBeforeUuid: string,
    options?: { timeoutMs?: number }
): Promise<{ success: boolean; newSessionId?: string; errorMessage?: string }> {
    const timeoutMs = options?.timeoutMs ?? 90000; // Longer timeout for fork + truncate operation

    try {
        const rpcPromise = apiSocket.machineRPC<any, { sessionId: string; truncateBeforeUuid: string }>(
            machineId,
            'claude-duplicate-session',
            { sessionId: claudeSessionId, truncateBeforeUuid }
        );

        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('Request timed out')), timeoutMs);
        });

        const result = await Promise.race([rpcPromise, timeoutPromise]);

        if (!result) {
            return { success: false, errorMessage: 'RPC returned empty response' };
        }
        if (result.error) {
            return { success: false, errorMessage: result.error };
        }
        return {
            success: result.success ?? false,
            newSessionId: result.newSessionId,
            errorMessage: result.errorMessage
        };
    } catch (error) {
        // Catch RPC errors (method not found, timeout, etc.)
        return {
            success: false,
            errorMessage: error instanceof Error ? error.message : 'Unknown RPC error'
        };
    }
}

/**
 * Fork a Claude session without truncation
 * Creates a new session that is a full copy of the original
 */
export async function machineForkClaudeSession(
    machineId: string,
    claudeSessionId: string,
    options?: { timeoutMs?: number }
): Promise<{ success: boolean; newSessionId?: string; errorMessage?: string }> {
    const timeoutMs = options?.timeoutMs ?? 90000;

    try {
        const rpcPromise = apiSocket.machineRPC<any, { sessionId: string }>(
            machineId,
            'claude-fork-session',
            { sessionId: claudeSessionId }
        );

        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('Request timed out')), timeoutMs);
        });

        const result = await Promise.race([rpcPromise, timeoutPromise]);

        if (!result) {
            return { success: false, errorMessage: 'RPC returned empty response' };
        }
        if (result.error) {
            return { success: false, errorMessage: result.error };
        }
        return {
            success: result.success ?? false,
            newSessionId: result.newSessionId,
            errorMessage: result.errorMessage
        };
    } catch (error) {
        return {
            success: false,
            errorMessage: error instanceof Error ? error.message : 'Unknown RPC error'
        };
    }
}

// --- Gemini session operations ---

/**
 * Get user messages from a Gemini session
 */
export async function machineGetGeminiSessionUserMessages(
    machineId: string,
    sessionId: string,
    options?: { limit?: number; timeoutMs?: number }
): Promise<{ messages: UserMessageWithUuid[] }> {
    const timeoutMs = options?.timeoutMs ?? 15000;
    const limit = options?.limit ?? 50;

    const rpcPromise = apiSocket.machineRPC<any, { sessionId: string; limit: number }>(
        machineId,
        'gemini-session-user-messages',
        { sessionId, limit }
    );

    const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Request timed out')), timeoutMs);
    });

    const result = await Promise.race([rpcPromise, timeoutPromise]);

    if (!result) {
        throw new Error('RPC returned empty response');
    }
    if (result.error) {
        throw new Error(result.error);
    }
    return { messages: Array.isArray(result.messages) ? result.messages : [] };
}

/**
 * Duplicate (fork and truncate) a Gemini session
 */
export async function machineDuplicateGeminiSession(
    machineId: string,
    sessionId: string,
    truncateBeforeUuid: string,
    options?: { timeoutMs?: number }
): Promise<{ success: boolean; newSessionId?: string; errorMessage?: string }> {
    const timeoutMs = options?.timeoutMs ?? 90000;

    try {
        const rpcPromise = apiSocket.machineRPC<any, { sessionId: string; truncateBeforeUuid: string }>(
            machineId,
            'gemini-duplicate-session',
            { sessionId, truncateBeforeUuid }
        );

        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('Request timed out')), timeoutMs);
        });

        const result = await Promise.race([rpcPromise, timeoutPromise]);

        if (!result) {
            return { success: false, errorMessage: 'RPC returned empty response' };
        }
        if (result.error) {
            return { success: false, errorMessage: result.error };
        }
        return {
            success: result.success ?? false,
            newSessionId: result.newSessionId,
            errorMessage: result.errorMessage
        };
    } catch (error) {
        return {
            success: false,
            errorMessage: error instanceof Error ? error.message : 'Unknown RPC error'
        };
    }
}

/**
 * Fork a Gemini session without truncation (resume)
 */
export async function machineForkGeminiSession(
    machineId: string,
    sessionId: string,
    options?: { timeoutMs?: number }
): Promise<{ success: boolean; newSessionId?: string; errorMessage?: string }> {
    const timeoutMs = options?.timeoutMs ?? 90000;

    try {
        const rpcPromise = apiSocket.machineRPC<any, { sessionId: string }>(
            machineId,
            'gemini-fork-session',
            { sessionId }
        );

        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('Request timed out')), timeoutMs);
        });

        const result = await Promise.race([rpcPromise, timeoutPromise]);

        if (!result) {
            return { success: false, errorMessage: 'RPC returned empty response' };
        }
        if (result.error) {
            return { success: false, errorMessage: result.error };
        }
        return {
            success: result.success ?? false,
            newSessionId: result.newSessionId,
            errorMessage: result.errorMessage
        };
    } catch (error) {
        return {
            success: false,
            errorMessage: error instanceof Error ? error.message : 'Unknown RPC error'
        };
    }
}

// --- Codex session operations ---

/**
 * Get user messages from a Codex session
 */
export async function machineGetCodexSessionUserMessages(
    machineId: string,
    codexSessionId: string,
    options?: { limit?: number; timeoutMs?: number }
): Promise<{ messages: UserMessageWithUuid[] }> {
    const timeoutMs = options?.timeoutMs ?? 15000;
    const limit = options?.limit ?? 50;

    const rpcPromise = apiSocket.machineRPC<any, { codexSessionId: string; limit: number }>(
        machineId,
        'codex-session-user-messages',
        { codexSessionId, limit }
    );

    const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Request timed out')), timeoutMs);
    });

    const result = await Promise.race([rpcPromise, timeoutPromise]);

    if (!result) {
        throw new Error('RPC returned empty response');
    }
    if (result.error) {
        throw new Error(result.error);
    }
    return { messages: Array.isArray(result.messages) ? result.messages : [] };
}

/**
 * Duplicate (fork and truncate) a Codex session
 */
export async function machineDuplicateCodexSession(
    machineId: string,
    codexSessionId: string,
    truncateBeforeUuid: string,
    options?: { timeoutMs?: number }
): Promise<{ success: boolean; newFilePath?: string; errorMessage?: string }> {
    const timeoutMs = options?.timeoutMs ?? 90000;

    try {
        const rpcPromise = apiSocket.machineRPC<any, { codexSessionId: string; truncateBeforeUuid: string }>(
            machineId,
            'codex-duplicate-session',
            { codexSessionId, truncateBeforeUuid }
        );

        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('Request timed out')), timeoutMs);
        });

        const result = await Promise.race([rpcPromise, timeoutPromise]);

        if (!result) {
            return { success: false, errorMessage: 'RPC returned empty response' };
        }
        if (result.error) {
            return { success: false, errorMessage: result.error };
        }
        return {
            success: result.success ?? false,
            newFilePath: result.newFilePath,
            errorMessage: result.errorMessage
        };
    } catch (error) {
        return {
            success: false,
            errorMessage: error instanceof Error ? error.message : 'Unknown RPC error'
        };
    }
}

/**
 * Fork a Codex session without truncation (resume)
 */
export async function machineForkCodexSession(
    machineId: string,
    codexSessionId: string,
    options?: { timeoutMs?: number }
): Promise<{ success: boolean; newFilePath?: string; errorMessage?: string }> {
    const timeoutMs = options?.timeoutMs ?? 90000;

    try {
        const rpcPromise = apiSocket.machineRPC<any, { codexSessionId: string }>(
            machineId,
            'codex-fork-session',
            { codexSessionId }
        );

        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('Request timed out')), timeoutMs);
        });

        const result = await Promise.race([rpcPromise, timeoutPromise]);

        if (!result) {
            return { success: false, errorMessage: 'RPC returned empty response' };
        }
        if (result.error) {
            return { success: false, errorMessage: result.error };
        }
        return {
            success: result.success ?? false,
            newFilePath: result.newFilePath,
            errorMessage: result.errorMessage
        };
    } catch (error) {
        return {
            success: false,
            errorMessage: error instanceof Error ? error.message : 'Unknown RPC error'
        };
    }
}

// Export types for external use
export type {
    SessionBashRequest,
    SessionBashResponse,
    SessionReadFileResponse,
    SessionWriteFileResponse,
    SessionListDirectoryResponse,
    DirectoryEntry,
    SessionGetDirectoryTreeResponse,
    TreeNode,
    SessionRipgrepResponse,
    SessionKillResponse
};
