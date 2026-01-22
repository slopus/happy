/**
 * Session operations for remote procedure calls
 * Provides strictly typed functions for all session-related RPC operations
 */

import { apiSocket } from './apiSocket';
import { sync } from './sync';
import type { MachineMetadata } from './storageTypes';
import { buildSpawnHappySessionRpcParams, type SpawnHappySessionRpcParams, type SpawnSessionOptions } from './spawnSessionPayload';
import {
    parseCapabilitiesDescribeResponse,
    parseCapabilitiesDetectResponse,
    parseCapabilitiesInvokeResponse,
    type CapabilitiesDescribeResponse,
    type CapabilitiesDetectRequest,
    type CapabilitiesDetectResponse,
    type CapabilitiesInvokeRequest,
    type CapabilitiesInvokeResponse,
} from './capabilitiesProtocol';

export type { SpawnHappySessionRpcParams, SpawnSessionOptions } from './spawnSessionPayload';
export { buildSpawnHappySessionRpcParams } from './spawnSessionPayload';
export type {
    CapabilitiesDescribeResponse,
    CapabilitiesDetectRequest,
    CapabilitiesDetectResponse,
    CapabilitiesInvokeRequest,
    CapabilitiesInvokeResponse,
} from './capabilitiesProtocol';

// Strict type definitions for all operations

// Permission operation types
interface SessionPermissionRequest {
    id: string;
    approved: boolean;
    reason?: string;
    mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    allowTools?: string[];
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
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

// Exported session operation functions

/**
 * Spawn a new remote session on a specific machine
 */
export async function machineSpawnNewSession(options: SpawnSessionOptions): Promise<SpawnSessionResult> {
    const { machineId } = options;

    try {
        const params = buildSpawnHappySessionRpcParams(options);
        const result = await apiSocket.machineRPC<SpawnSessionResult, SpawnHappySessionRpcParams>(machineId, 'spawn-happy-session', params);
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
 * Result type for resume session operation.
 */
export type ResumeSessionResult =
    | { type: 'success' }
    | { type: 'error'; errorMessage: string };

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
    /** The agent type (claude, codex, gemini) */
    agent: 'codex' | 'claude' | 'gemini';
    /**
     * Experimental: allow Codex vendor resume when agent === 'codex'.
     * Ignored for other agents.
     */
    experimentalCodexResume?: boolean;
}

/**
 * Resume an inactive session by spawning a new CLI process that reconnects
 * to the existing Happy session and resumes the agent.
 */
export async function resumeSession(options: ResumeSessionOptions): Promise<ResumeSessionResult> {
    const { sessionId, machineId, directory, agent, experimentalCodexResume } = options;

    try {
        const result = await apiSocket.machineRPC<ResumeSessionResult, {
            type: 'resume-session';
            sessionId: string;
            directory: string;
            agent: 'codex' | 'claude' | 'gemini';
            experimentalCodexResume?: boolean;
        }>(
            machineId,
            'spawn-happy-session',
            {
                type: 'resume-session',
                sessionId,
                directory,
                agent,
                experimentalCodexResume,
            }
        );
        return result;
    } catch (error) {
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to resume session'
        };
    }
}

export type MachineCapabilitiesDescribeResult =
    | { supported: true; response: CapabilitiesDescribeResponse }
    | { supported: false; reason: 'not-supported' | 'error' };

export async function machineCapabilitiesDescribe(machineId: string): Promise<MachineCapabilitiesDescribeResult> {
    try {
        const result = await apiSocket.machineRPC<unknown, {}>(machineId, 'capabilities.describe', {});
        if (isPlainObject(result) && typeof result.error === 'string') {
            if (result.error === 'Method not found') return { supported: false, reason: 'not-supported' };
            return { supported: false, reason: 'error' };
        }
        const parsed = parseCapabilitiesDescribeResponse(result);
        if (!parsed) return { supported: false, reason: 'error' };
        return { supported: true, response: parsed };
    } catch {
        return { supported: false, reason: 'error' };
    }
}

export type MachineCapabilitiesDetectResult =
    | { supported: true; response: CapabilitiesDetectResponse }
    | { supported: false; reason: 'not-supported' | 'error' };

export async function machineCapabilitiesDetect(
    machineId: string,
    request: CapabilitiesDetectRequest,
    options?: { timeoutMs?: number },
): Promise<MachineCapabilitiesDetectResult> {
    try {
        const timeoutMs = typeof options?.timeoutMs === 'number' ? options.timeoutMs : 2500;
        const result = await Promise.race([
            apiSocket.machineRPC<unknown, CapabilitiesDetectRequest>(machineId, 'capabilities.detect', request),
            new Promise<{ error: string }>((resolve) => {
                setTimeout(() => resolve({ error: 'Timeout' }), timeoutMs);
            }),
        ]);

        if (isPlainObject(result) && typeof result.error === 'string') {
            if (result.error === 'Method not found') return { supported: false, reason: 'not-supported' };
            return { supported: false, reason: 'error' };
        }

        const parsed = parseCapabilitiesDetectResponse(result);
        if (!parsed) return { supported: false, reason: 'error' };
        return { supported: true, response: parsed };
    } catch {
        return { supported: false, reason: 'error' };
    }
}

export type MachineCapabilitiesInvokeResult =
    | { supported: true; response: CapabilitiesInvokeResponse }
    | { supported: false; reason: 'not-supported' | 'error' };

export async function machineCapabilitiesInvoke(
    machineId: string,
    request: CapabilitiesInvokeRequest,
    options?: { timeoutMs?: number },
): Promise<MachineCapabilitiesInvokeResult> {
    try {
        const timeoutMs = typeof options?.timeoutMs === 'number' ? options.timeoutMs : 30_000;
        const result = await Promise.race([
            apiSocket.machineRPC<unknown, CapabilitiesInvokeRequest>(machineId, 'capabilities.invoke', request),
            new Promise<{ error: string }>((resolve) => {
                setTimeout(() => resolve({ error: 'Timeout' }), timeoutMs);
            }),
        ]);

        if (isPlainObject(result) && typeof result.error === 'string') {
            if (result.error === 'Method not found') return { supported: false, reason: 'not-supported' };
            return { supported: false, reason: 'error' };
        }

        const parsed = parseCapabilitiesInvokeResponse(result);
        if (!parsed) return { supported: false, reason: 'error' };
        return { supported: true, response: parsed };
    } catch {
        return { supported: false, reason: 'error' };
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

export type EnvPreviewSecretsPolicy = 'none' | 'redacted' | 'full';

export type PreviewEnvSensitivitySource = 'forced' | 'hinted' | 'none';

export interface PreviewEnvValue {
    value: string | null;
    isSet: boolean;
    isSensitive: boolean;
    isForcedSensitive: boolean;
    sensitivitySource: PreviewEnvSensitivitySource;
    display: 'full' | 'redacted' | 'hidden' | 'unset';
}

export interface PreviewEnvResponse {
    policy: EnvPreviewSecretsPolicy;
    values: Record<string, PreviewEnvValue>;
}

interface PreviewEnvRequest {
    keys: string[];
    extraEnv?: Record<string, string>;
    sensitiveKeys?: string[];
}

export type MachinePreviewEnvResult =
    | { supported: true; response: PreviewEnvResponse }
    | { supported: false };

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Preview environment variables exactly as the daemon will spawn them.
 *
 * This calls the daemon's `preview-env` RPC (if supported). The daemon computes:
 * - effective env = { ...daemon.process.env, ...expand(extraEnv) }
 * - applies `HAPPY_ENV_PREVIEW_SECRETS` policy for sensitive variables
 *
 * If the daemon is old and doesn't support `preview-env`, returns `{ supported: false }`.
 */
export async function machinePreviewEnv(
    machineId: string,
    params: PreviewEnvRequest
): Promise<MachinePreviewEnvResult> {
    try {
        const result = await apiSocket.machineRPC<unknown, PreviewEnvRequest>(
            machineId,
            'preview-env',
            params
        );

        if (isPlainObject(result) && typeof result.error === 'string') {
            // Older daemons (or errors) return an encrypted `{ error: ... }` payload.
            // Treat method-not-found as “unsupported” and fallback to bash-based probing.
            if (result.error === 'Method not found') {
                return { supported: false };
            }
            // For any other error, degrade gracefully in UI by using fallback behavior.
            return { supported: false };
        }

        // Basic shape validation (be defensive for mixed daemon versions).
        if (
            !isPlainObject(result) ||
            (result.policy !== 'none' && result.policy !== 'redacted' && result.policy !== 'full') ||
            !isPlainObject(result.values)
        ) {
            return { supported: false };
        }

        const response: PreviewEnvResponse = {
            policy: result.policy as EnvPreviewSecretsPolicy,
            values: Object.fromEntries(
                Object.entries(result.values as Record<string, unknown>).map(([k, v]) => {
                    if (!isPlainObject(v)) {
                        const fallback: PreviewEnvValue = {
                            value: null,
                            isSet: false,
                            isSensitive: false,
                            isForcedSensitive: false,
                            sensitivitySource: 'none',
                            display: 'unset',
                        };
                        return [k, fallback] as const;
                    }

                    const display = v.display;
                    const safeDisplay =
                        display === 'full' || display === 'redacted' || display === 'hidden' || display === 'unset'
                            ? display
                            : 'unset';

                    const value = v.value;
                    const safeValue = typeof value === 'string' ? value : null;

                    const isSet = v.isSet;
                    const safeIsSet = typeof isSet === 'boolean' ? isSet : safeValue !== null;

                    const isSensitive = v.isSensitive;
                    const safeIsSensitive = typeof isSensitive === 'boolean' ? isSensitive : false;

                    // Back-compat for intermediate daemons: default to “not forced” if missing.
                    const isForcedSensitive = v.isForcedSensitive;
                    const safeIsForcedSensitive = typeof isForcedSensitive === 'boolean' ? isForcedSensitive : false;

                    const sensitivitySource = v.sensitivitySource;
                    const safeSensitivitySource: PreviewEnvSensitivitySource =
                        sensitivitySource === 'forced' || sensitivitySource === 'hinted' || sensitivitySource === 'none'
                            ? sensitivitySource
                            : (safeIsSensitive ? 'hinted' : 'none');

                    const entry: PreviewEnvValue = {
                        value: safeValue,
                        isSet: safeIsSet,
                        isSensitive: safeIsSensitive,
                        isForcedSensitive: safeIsForcedSensitive,
                        sensitivitySource: safeSensitivitySource,
                        display: safeDisplay,
                    };

                    return [k, entry] as const;
                }),
            ) as Record<string, PreviewEnvValue>,
        };
        return { supported: true, response };
    } catch {
        return { supported: false };
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
export async function sessionAllow(sessionId: string, id: string, mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan', allowedTools?: string[], decision?: 'approved' | 'approved_for_session'): Promise<void> {
    const request: SessionPermissionRequest = { id, approved: true, mode, allowTools: allowedTools, decision };
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
            message: error instanceof Error ? error.message : 'Unknown error'
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
    const isRpcMethodUnavailable = message.toLowerCase().includes('rpc method not available');

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

        // Get current session to get current metadata version
        const session = sync.encryption.getSessionEncryption(sessionId);
        if (!session) {
            return {
                success: false,
                message: 'Session not found'
            };
        }

        // Get the current session from storage
        const { storage } = await import('./storage');
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
