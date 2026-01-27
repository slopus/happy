/**
 * Session operations for remote procedure calls
 */

import { apiSocket } from '../apiSocket';
import { sync } from '../sync';
import { isRpcMethodNotAvailableError } from '../rpcErrors';
import { buildResumeHappySessionRpcParams, type ResumeHappySessionRpcParams } from '../resumeSessionPayload';
import type { AgentId } from '@/agents/catalog';
import type { PermissionMode } from '@/sync/permissionTypes';
import type { SpawnSessionResult } from '@happy/protocol';
import { SPAWN_SESSION_ERROR_CODES } from '@happy/protocol';
import { RPC_METHODS } from '@happy/protocol/rpc';
import { normalizeSpawnSessionResult } from './_shared';


// Permission operation types
interface SessionPermissionRequest {
    id: string;
    approved: boolean;
    reason?: string;
    mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    allowedTools?: string[];
    decision?: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort';
    execPolicyAmendment?: {
        command: string[];
    };
    /**
     * AskUserQuestion: structured answers keyed by question text.
     * When present, the agent can complete the tool call without requiring a follow-up user message.
     */
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
    errorCode?: string;
}

// Response types for spawn session
export type ResumeSessionResult = SpawnSessionResult;

/**
 * Options for resuming an inactive session.
 */
export interface ResumeSessionOptions {
    /** The Happy session ID to resume */
    sessionId: string;
    /** The machine ID where the session was running */
    machineId: string;
    /** The directory where the session was running */
    directory: string;
    /** The agent id */
    agent: AgentId;
    /** Optional vendor resume id (e.g. Claude/Codex session id). */
    resume?: string;
    /** Session encryption key (dataKey mode) encoded as base64. */
    sessionEncryptionKeyBase64: string;
    /** Session encryption variant (only dataKey supported for resume). */
    sessionEncryptionVariant: 'dataKey';
    /**
     * Optional: publish an explicit UI-selected permission mode at resume time.
     * Use only when the UI selection is newer than metadata.permissionModeUpdatedAt.
     */
    permissionMode?: PermissionMode;
    permissionModeUpdatedAt?: number;
    /**
     * Experimental: allow Codex vendor resume when agent === 'codex'.
     * Ignored for other agents.
     */
    experimentalCodexResume?: boolean;
    /**
     * Experimental: route Codex through ACP (codex-acp) when agent === 'codex'.
     * Ignored for other agents.
     */
    experimentalCodexAcp?: boolean;
}

/**
 * Resume an inactive session by spawning a new CLI process that reconnects
 * to the existing Happy session and resumes the agent.
 */
export async function resumeSession(options: ResumeSessionOptions): Promise<ResumeSessionResult> {
    const { sessionId, machineId, directory, agent, resume, sessionEncryptionKeyBase64, sessionEncryptionVariant, permissionMode, permissionModeUpdatedAt, experimentalCodexResume, experimentalCodexAcp } = options;

    try {
        const params: ResumeHappySessionRpcParams = buildResumeHappySessionRpcParams({
            sessionId,
            directory,
            agent,
            ...(resume ? { resume } : {}),
            sessionEncryptionKeyBase64,
            sessionEncryptionVariant,
            ...(permissionMode ? { permissionMode } : {}),
            ...(typeof permissionModeUpdatedAt === 'number' ? { permissionModeUpdatedAt } : {}),
            experimentalCodexResume,
            experimentalCodexAcp,
        });

        const result = await apiSocket.machineRPC<unknown, ResumeHappySessionRpcParams>(
            machineId,
            RPC_METHODS.SPAWN_HAPPY_SESSION,
            params
        );
        return normalizeSpawnSessionResult(result);
    } catch (error) {
        return {
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
            errorMessage: error instanceof Error ? error.message : 'Failed to resume session'
        };
    }
}

export async function sessionAbort(sessionId: string): Promise<void> {
    try {
        await apiSocket.sessionRPC(sessionId, 'abort', {
            reason: `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.`
        });
    } catch (e) {
        if (e instanceof Error && isRpcMethodNotAvailableError(e as any)) {
            // Session RPCs are unavailable when no agent process is attached (inactive/resumable).
            // Treat abort as a no-op in that case.
            return;
        }
        throw e;
    }
}

/**
 * Allow a permission request
 */
export async function sessionAllow(
    sessionId: string,
    id: string,
    mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan',
    allowedTools?: string[],
    decision?: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment',
    execPolicyAmendment?: { command: string[] }
): Promise<void> {
    const request: SessionPermissionRequest = {
        id,
        approved: true,
        mode,
        allowedTools,
        decision,
        execPolicyAmendment
    };
    await apiSocket.sessionRPC(sessionId, 'permission', request);
}

/**
 * Allow a permission request and attach structured answers (AskUserQuestion).
 *
 * This uses the existing `permission` RPC (no separate RPC required).
 */
export async function sessionAllowWithAnswers(
    sessionId: string,
    id: string,
    answers: Record<string, string>,
): Promise<void> {
    const request: SessionPermissionRequest = {
        id,
        approved: true,
        answers,
    };
    await apiSocket.sessionRPC(sessionId, 'permission', request);
}

/**
 * Deny a permission request
 */
export async function sessionDeny(
    sessionId: string,
    id: string,
    mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan',
    allowedTools?: string[],
    decision?: 'denied' | 'abort',
    reason?: string,
): Promise<void> {
    const request: SessionPermissionRequest = { id, approved: false, mode, allowedTools, decision, reason };
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
            message: error instanceof Error ? error.message : 'Unknown error',
            errorCode: error && typeof error === 'object' ? (error as any).rpcErrorCode : undefined,
        };
    }
}

export interface SessionArchiveResponse {
    success: boolean;
    message?: string;
}

/**
 * Archive a session.
 *
 * Primary behavior: kill the session process (same as previous "archive" behavior).
 * Fallback: if the session RPC method is unavailable (e.g. session crashed / disconnected),
 * mark the session inactive server-side so it no longer appears "online".
 */
export async function sessionArchive(sessionId: string): Promise<SessionArchiveResponse> {
    const killResult = await sessionKill(sessionId);
    if (killResult.success) {
        return { success: true };
    }

    const message = killResult.message || 'Failed to archive session';
    const isRpcMethodUnavailable = isRpcMethodNotAvailableError({
        rpcErrorCode: killResult.errorCode,
        message,
    });

    if (isRpcMethodUnavailable) {
        try {
            apiSocket.send('session-end', { sid: sessionId, time: Date.now() });
        } catch {
            // Best-effort: server will also eventually time out stale sessions.
        }
        return { success: true };
    }

    return { success: false, message };
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

// Session rename types
interface SessionRenameRequest {
    title: string;
}

interface SessionRenameResponse {
    success: boolean;
    message?: string;
}

/**
 * Rename a session by updating its metadata summary
 * This updates the session title displayed in the UI
 */
export async function sessionRename(sessionId: string, title: string): Promise<SessionRenameResponse> {
    try {
        const sessionEncryption = sync.encryption.getSessionEncryption(sessionId);
        if (!sessionEncryption) {
            return {
                success: false,
                message: 'Session encryption not found'
            };
        }

        // Get the current session from storage
        const { storage } = await import('../storage');
        const currentSession = storage.getState().sessions[sessionId];
        if (!currentSession) {
            return {
                success: false,
                message: 'Session not found in storage'
            };
        }

        // Ensure we have valid metadata to update
        if (!currentSession.metadata) {
            return {
                success: false,
                message: 'Session metadata not available'
            };
        }

        // Update metadata with new summary
        const updatedMetadata = {
            ...currentSession.metadata,
            summary: {
                text: title,
                updatedAt: Date.now()
            }
        };

        // Encrypt the updated metadata
        const encryptedMetadata = await sessionEncryption.encryptMetadata(updatedMetadata);

        // Send update to server
        const result = await apiSocket.emitWithAck<{
            result: 'success' | 'version-mismatch' | 'error';
            version?: number;
            metadata?: string;
            message?: string;
        }>('update-metadata', {
            sid: sessionId,
            expectedVersion: currentSession.metadataVersion,
            metadata: encryptedMetadata
        });

        if (result.result === 'success') {
            return { success: true };
        } else if (result.result === 'version-mismatch') {
            // Retry with updated version
            return {
                success: false,
                message: 'Version conflict, please try again'
            };
        } else {
            return {
                success: false,
                message: result.message || 'Failed to rename session'
            };
        }
    } catch (error) {
        return {
            success: false,
            message: error instanceof Error ? error.message : 'Unknown error'
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
    SessionKillResponse,
    SessionRenameResponse
};
