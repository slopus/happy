import type { TerminalSpawnOptions } from '@/terminal/terminalConfig';
import type { PermissionMode } from '@/api/types';
import type { CatalogAgentId } from '@/backends/types';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { SpawnSessionErrorCode } from '@happy/protocol';
export { SPAWN_SESSION_ERROR_CODES } from '@happy/protocol';
export type { SpawnSessionErrorCode } from '@happy/protocol';
import { registerCapabilitiesHandlers } from './capabilities';
import { registerPreviewEnvHandler } from './previewEnv';
import { registerBashHandler } from './bash';
import { registerFileSystemHandlers } from './fileSystem';
import { registerRipgrepHandler } from './ripgrep';
import { registerDifftasticHandler } from './difftastic';

/*
 * Spawn Session Options and Result
 * This rpc type is used by the daemon, all other RPCs here are for sessions
 */

export interface SpawnSessionOptions {
    machineId?: string;
    directory: string;
    sessionId?: string;
    /**
     * Resume an existing agent session by id (vendor resume).
     *
     * Upstream intent: Claude (`--resume <sessionId>`).
     * If resume is requested for an unsupported agent, the daemon should return an error
     * rather than silently spawning a fresh session.
     */
    resume?: string;
    /**
     * Experimental: allow Codex vendor resume for this spawn.
     * This is evaluated by the daemon BEFORE spawning the child process.
     */
    experimentalCodexResume?: boolean;
    /**
     * Experimental: switch Codex sessions to use ACP (codex-acp) instead of MCP.
     * This is evaluated by the daemon BEFORE spawning the child process.
     */
    experimentalCodexAcp?: boolean;
    /**
     * Existing Happy session ID to reconnect to (for inactive session resume).
     * When set, the CLI will connect to this session instead of creating a new one.
     */
    existingSessionId?: string;
    /**
     * Session encryption key (dataKey mode only) encoded as base64.
     * Required when existingSessionId is set.
     */
    sessionEncryptionKeyBase64?: string;
    /**
     * Session encryption variant (resume only supports dataKey).
     * Required when existingSessionId is set.
     */
    sessionEncryptionVariant?: 'dataKey';
    /**
     * Optional: explicit permission mode to publish at startup (seed or override).
     * When omitted, the runner preserves existing metadata.permissionMode.
     */
    permissionMode?: PermissionMode;
    /**
     * Optional timestamp for permissionMode (ms). Used to order explicit UI selections across devices.
     */
    permissionModeUpdatedAt?: number;
    approvedNewDirectoryCreation?: boolean;
    agent?: CatalogAgentId;
    token?: string;
    /**
     * Daemon/runtime terminal configuration for the spawned session (non-secret).
     * Preferred over legacy TMUX_* env vars.
     */
    terminal?: TerminalSpawnOptions;
    /**
     * Session-scoped profile identity for display/debugging across devices.
     * This is NOT the profile content; actual runtime behavior is still driven
     * by environmentVariables passed for this spawn.
     *
     * Empty string is allowed and means "no profile".
     */
    profileId?: string;
    /**
     * Arbitrary environment variables for the spawned session.
     *
     * The GUI builds these from a profile (env var list + tmux settings) and may include
     * provider-specific keys like:
     * - ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL / ANTHROPIC_MODEL
     * - OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL
     * - AZURE_OPENAI_* / TOGETHER_*
     * - TMUX_SESSION_NAME / TMUX_TMPDIR
     */
    environmentVariables?: Record<string, string>;
}

export type SpawnSessionResult =
    | { type: 'success'; sessionId?: string }
    | { type: 'requestToApproveDirectoryCreation'; directory: string }
    | { type: 'error'; errorCode: SpawnSessionErrorCode; errorMessage: string };

/**
 * Register all session RPC handlers with the daemon
 */
export function registerSessionHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string) {
    registerBashHandler(rpcHandlerManager, workingDirectory);
    // Checklist-based machine capability registry (replaces legacy detect-cli / detect-capabilities / dep-status).
    registerCapabilitiesHandlers(rpcHandlerManager);
    registerPreviewEnvHandler(rpcHandlerManager);
    registerFileSystemHandlers(rpcHandlerManager, workingDirectory);
    registerRipgrepHandler(rpcHandlerManager, workingDirectory);
    registerDifftasticHandler(rpcHandlerManager, workingDirectory);
}
