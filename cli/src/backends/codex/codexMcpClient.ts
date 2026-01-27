/**
 * Codex MCP Client - Simple wrapper for Codex tools
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { logger } from '@/ui/logger';
import type { CodexSessionConfig, CodexToolResponse } from './types';
import { z } from 'zod';
import { ElicitRequestParamsSchema, RequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CodexPermissionHandler } from './utils/permissionHandler';
import { execFileSync } from 'child_process';
import { randomUUID } from 'node:crypto';

const DEFAULT_TIMEOUT = 14 * 24 * 60 * 60 * 1000; // 14 days, which is the half of the maximum possible timeout (~28 days for int32 value in NodeJS)

type CodexMcpClientSpawnMode = 'codex-cli' | 'mcp-server';

const ElicitRequestSchemaWithExtras = RequestSchema.extend({
    method: z.literal('elicitation/create'),
    // Codex adds extra fields beyond the MCP SDK schema; accept any params payload
    // and decode the codex_* fields at usage sites.
    params: z.any()
});

// ============================================================================
// Codex Elicitation Request Types (from Codex MCP server)
// Field names are stable since v0.9.0 - all use codex_* prefix
// ============================================================================

/** Common fields shared by all elicitation requests */
interface CodexElicitationBase {
    message: string;
    codex_elicitation: 'exec-approval' | 'patch-approval';
    codex_mcp_tool_call_id: string;
    codex_event_id: string;
    codex_call_id: string;
}

/** Exec approval request params (command execution) */
interface ExecApprovalParams extends CodexElicitationBase {
    codex_elicitation: 'exec-approval';
    codex_command: string[];
    codex_cwd: string;
    codex_parsed_cmd?: Array<{ cmd: string; args?: string[] }>;  // Added in ~v0.46
}

/** Patch approval request params (code changes) */
interface PatchApprovalParams extends CodexElicitationBase {
    codex_elicitation: 'patch-approval';
    codex_reason?: string;
    codex_grant_root?: string;
    codex_changes: Record<string, unknown>;
}

type CodexElicitationParams = ExecApprovalParams | PatchApprovalParams;

// ============================================================================
// Elicitation Response Types
// ============================================================================

type ElicitationAction = 'accept' | 'decline' | 'cancel';

/**
 * Codex ReviewDecision::ApprovedExecpolicyAmendment variant
 *
 * Rust definition uses:
 * - #[serde(rename_all = "snake_case")] on enum -> variant name is snake_case
 * - #[serde(transparent)] on ExecPolicyAmendment -> serializes as array directly
 *
 * Result: { "approved_execpolicy_amendment": { "proposed_execpolicy_amendment": ["cmd", "arg1", ...] } }
 */
type ExecpolicyAmendmentDecision = {
    approved_execpolicy_amendment: {
        proposed_execpolicy_amendment: string[];  // transparent: directly an array, not { command: [...] }
    };
};
/**
 * Codex ReviewDecision enum - uses #[serde(rename_all = "snake_case")]
 * See: codex-rs/protocol/src/protocol.rs
 */
type ReviewDecision =
    | 'approved'
    | 'approved_for_session'
    | 'denied'
    | 'abort'
    | ExecpolicyAmendmentDecision;

/**
 * Response format changed in v0.77:
 * - 'decision': v0.9 ~ v0.77 (ReviewDecision only)
 * - 'both': v0.77+ (action + decision + content)
 */
type ElicitationResponseStyle = 'decision' | 'both';

export function getCodexElicitationToolCallId(params: Record<string, unknown>): string | undefined {
    const callId = params.codex_call_id;
    if (typeof callId === 'string') {
        return callId;
    }

    const mcpToolCallId = params.codex_mcp_tool_call_id;
    if (typeof mcpToolCallId === 'string') {
        return mcpToolCallId;
    }

    return undefined;
}

export function getCodexEventToolCallId(msg: Record<string, unknown>): string | undefined {
    const callId = msg.call_id ?? msg.codex_call_id;
    if (typeof callId === 'string') {
        return callId;
    }

    const mcpToolCallId = msg.mcp_tool_call_id ?? msg.codex_mcp_tool_call_id;
    if (typeof mcpToolCallId === 'string') {
        return mcpToolCallId;
    }

    return undefined;
}

// ============================================================================
// Version Detection
// ============================================================================

interface CodexVersionInfo {
    raw: string | null;
    parsed: boolean;
    major: number;
    minor: number;
    patch: number;
    prereleaseTag?: string;
    prereleaseNum?: number;
}

type CodexVersionTarget = Pick<
    CodexVersionInfo,
    'major' | 'minor' | 'patch' | 'prereleaseTag' | 'prereleaseNum'
>;

const MCP_SERVER_MIN_VERSION = {
    major: 0,
    minor: 43,
    patch: 0,
    prereleaseTag: 'alpha',
    prereleaseNum: 5
};

// Codex CLI <= 0.77.0 still expects ReviewDecision in exec/patch approvals.
const ELICITATION_DECISION_MAX_VERSION: CodexVersionTarget = {
    major: 0,
    minor: 77,
    patch: 0
};

const cachedCodexVersionInfoByCommand = new Map<string, CodexVersionInfo>();

function getCodexVersionInfo(codexCommand: string): CodexVersionInfo {
    const cached = cachedCodexVersionInfoByCommand.get(codexCommand);
    if (cached) return cached;

    try {
        const raw = execFileSync(codexCommand, ['--version'], { encoding: 'utf8' }).trim();
        const match = raw.match(/(?:codex(?:-cli)?)\s+v?(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?/i)
            ?? raw.match(/\b(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?\b/);
        if (!match) {
            const info: CodexVersionInfo = {
                raw,
                parsed: false,
                major: 0,
                minor: 0,
                patch: 0
            };
            cachedCodexVersionInfoByCommand.set(codexCommand, info);
            return info;
        }

        const major = Number(match[1]);
        const minor = Number(match[2]);
        const patch = Number(match[3]);
        const prereleaseTag = match[4];
        const prereleaseNum = match[5] ? Number(match[5]) : undefined;

        const info: CodexVersionInfo = {
            raw,
            parsed: true,
            major,
            minor,
            patch,
            prereleaseTag,
            prereleaseNum
        };
        cachedCodexVersionInfoByCommand.set(codexCommand, info);
        return info;
    } catch (error) {
        logger.debug(`[CodexMCP] Error detecting codex version for ${codexCommand}:`, error);
        const info: CodexVersionInfo = {
            raw: null,
            parsed: false,
            major: 0,
            minor: 0,
            patch: 0
        };
        cachedCodexVersionInfoByCommand.set(codexCommand, info);
        return info;
    }
}

function compareVersions(info: CodexVersionInfo, target: CodexVersionTarget): number {
    if (info.major !== target.major) return info.major - target.major;
    if (info.minor !== target.minor) return info.minor - target.minor;
    if (info.patch !== target.patch) return info.patch - target.patch;

    const infoTag = info.prereleaseTag;
    const targetTag = target.prereleaseTag;
    if (!infoTag && !targetTag) return 0;
    if (!infoTag && targetTag) return 1;
    if (infoTag && !targetTag) return -1;
    if (!infoTag || !targetTag) return 0;
    if (infoTag !== targetTag) return infoTag.localeCompare(targetTag);

    const infoNum = info.prereleaseNum ?? 0;
    const targetNum = target.prereleaseNum ?? 0;
    return infoNum - targetNum;
}

function isVersionAtLeast(info: CodexVersionInfo, target: CodexVersionTarget): boolean {
    if (!info.parsed) return false;
    return compareVersions(info, target) >= 0;
}

function isVersionAtMost(info: CodexVersionInfo, target: CodexVersionTarget): boolean {
    if (!info.parsed) return false;
    return compareVersions(info, target) <= 0;
}

function getElicitationResponseStyle(info: CodexVersionInfo): ElicitationResponseStyle {
    const override = process.env.HAPPY_CODEX_ELICITATION_STYLE?.toLowerCase();
    if (override === 'decision' || override === 'both') {
        return override;
    }

    // Default to 'both' if version unknown (safer for newer versions)
    if (!info.parsed) return 'both';
    // v0.77 and earlier expect ReviewDecision format
    return isVersionAtMost(info, ELICITATION_DECISION_MAX_VERSION) ? 'decision' : 'both';
}

function buildElicitationResponse(
    style: ElicitationResponseStyle,
    action: ElicitationAction,
    decision: ReviewDecision
): { action: ElicitationAction; decision?: ReviewDecision; content?: Record<string, unknown> } {
    if (style === 'decision') {
        // v0.77 and earlier: ReviewDecision format
        return { action, decision };
    }
    // v0.77+: Full elicitation response with action + decision + content
    return { action, decision, content: {} };
}

function isExecpolicyAmendmentDecision(
    decision: ReviewDecision
): decision is ExecpolicyAmendmentDecision {
    return typeof decision === 'object'
        && decision !== null
        && 'approved_execpolicy_amendment' in decision;
}

/**
 * Get the correct MCP subcommand based on installed codex version
 * Versions >= 0.43.0-alpha.5 use 'mcp-server', older versions use 'mcp'
 */
function getCodexMcpCommand(codexCommand: string): string {
    const info = getCodexVersionInfo(codexCommand);
    if (!info.parsed) return 'mcp-server';

    // Version >= 0.43.0-alpha.5 has mcp-server
    return isVersionAtLeast(info, MCP_SERVER_MIN_VERSION) ? 'mcp-server' : 'mcp';
}

export class CodexMcpClient {
    private client: Client;
    private transport: StdioClientTransport | null = null;
    private connected: boolean = false;
    private threadId: string | null = null;
    private conversationId: string | null = null;
    private handler: ((event: any) => void) | null = null;
    private permissionHandler: CodexPermissionHandler | null = null;
    private codexCommand: string;
    private mode: CodexMcpClientSpawnMode;
    private mcpServerArgs: string[];
    /** Cached proposed_execpolicy_amendment from notifications, keyed by call_id */
    private pendingAmendments = new Map<string, string[]>();

    constructor(options?: { command?: string; mode?: CodexMcpClientSpawnMode; args?: string[] }) {
        this.codexCommand = options?.command ?? 'codex';
        this.mode = options?.mode ?? 'codex-cli';
        this.mcpServerArgs = options?.args ?? [];

        this.client = new Client(
            { name: 'happy-codex-client', version: '1.0.0' },
            { capabilities: { elicitation: {} } }
        );

        const CodexEventNotificationSchema = z.object({
            method: z.literal('codex/event'),
            params: z.object({
                msg: z.any()
            })
        }).passthrough() as any;

        this.client.setNotificationHandler(CodexEventNotificationSchema, (data: any) => {
            const msg = data.params.msg as Record<string, unknown> | null;
            this.updateIdentifiersFromEvent(msg);
            this.handler?.(msg);

            // Cache proposed_execpolicy_amendment for later use in elicitation request
            if (msg && msg.type === 'exec_approval_request') {
                const callId = getCodexEventToolCallId(msg);
                const amendment = msg.proposed_execpolicy_amendment;
                if (typeof callId === 'string' && Array.isArray(amendment)) {
                    this.pendingAmendments.set(callId, amendment.filter((p): p is string => typeof p === 'string'));
                }
            }
        });
    }

    setHandler(handler: ((event: any) => void) | null): void {
        this.handler = handler;
    }

    /**
     * Set the permission handler for tool approval
     */
    setPermissionHandler(handler: CodexPermissionHandler): void {
        this.permissionHandler = handler;
    }

    async connect(): Promise<void> {
        if (this.connected) return;

        const transportArgs = (() => {
            if (this.mode === 'mcp-server') {
                logger.debug(`[CodexMCP] Connecting to MCP server using command: ${this.codexCommand} ${this.mcpServerArgs.join(' ')}`.trim());
                return this.mcpServerArgs;
            }

            const versionInfo = getCodexVersionInfo(this.codexCommand);
            logger.debug('[CodexMCP] Detected codex version', versionInfo);

            if (versionInfo.raw === null) {
                throw new Error(
                    `Codex CLI not found or not executable: ${this.codexCommand}\n` +
                    '\n' +
                    'To install codex:\n' +
                    '  npm install -g @openai/codex\n' +
                    '\n' +
                    'Alternatively, use Claude:\n' +
                    '  happy claude'
                );
            }

            const mcpCommand = getCodexMcpCommand(this.codexCommand);
            logger.debug(`[CodexMCP] Connecting to Codex MCP server using command: ${this.codexCommand} ${mcpCommand}`);
            return [mcpCommand];
        })();

        this.transport = new StdioClientTransport({
            command: this.codexCommand,
            args: transportArgs,
            env: Object.keys(process.env).reduce((acc, key) => {
                const value = process.env[key];
                if (typeof value === 'string') acc[key] = value;
                return acc;
            }, {} as Record<string, string>)
        });

        // Register request handlers for Codex permission methods
        this.registerPermissionHandlers();

        await this.client.connect(this.transport);
        this.connected = true;

        logger.debug('[CodexMCP] Connected to Codex');
    }

    private registerPermissionHandlers(): void {
        const versionInfo = getCodexVersionInfo(this.codexCommand);
        const responseStyle = getElicitationResponseStyle(versionInfo);
        logger.debug('[CodexMCP] Elicitation response style', {
            style: responseStyle,
            version: versionInfo.raw
        });

        this.client.setRequestHandler(
            ElicitRequestSchemaWithExtras,
            async (request) => {
                const params = (request.params ?? {}) as Record<string, unknown>;
                logger.debugLargeJson('[CodexMCP] Received elicitation request', params);

                // Extract fields using stable codex_* field names (since v0.9).
                // Prefer codex_call_id/call_id for local correlation because codex_mcp_tool_call_id can repeat.
                const toolCallId = getCodexElicitationToolCallId(params) ?? randomUUID();
                const elicitationType = this.extractString(params, 'codex_elicitation');
                const message = this.extractString(params, 'message') ?? '';

                const isPatchApproval = elicitationType === 'patch-approval';
                const toolName = isPatchApproval ? 'CodexPatch' : 'CodexBash';

                // Get and consume cached proposed_execpolicy_amendment from notification
                const cachedAmendment = this.pendingAmendments.get(toolCallId);
                this.pendingAmendments.delete(toolCallId);

                // Build tool input based on elicitation type
                const toolInput = isPatchApproval
                    ? this.buildPatchToolInput(params, message)
                    : this.buildExecToolInput(params, cachedAmendment);

                logger.debug('[CodexMCP] Permission request', {
                    toolCallId,
                    toolName,
                    elicitationType
                });

                // Deny by default if no permission handler
                if (!this.permissionHandler) {
                    logger.debug('[CodexMCP] No permission handler, denying');
                    return buildElicitationResponse(responseStyle, 'decline', 'denied');
                }

                try {
                    const result = await this.permissionHandler.handleToolCall(
                        toolCallId,
                        toolName,
                        toolInput
                    );

                    const decision = this.mapResultToDecision(result);
                    const action = this.mapDecisionToAction(decision);

                    logger.debug('[CodexMCP] Sending response', {
                        toolCallId,
                        decision,
                        action,
                        responseStyle
                    });
                    return buildElicitationResponse(responseStyle, action, decision);
                } catch (error) {
                    logger.debug('[CodexMCP] Error handling permission:', error);
                    return buildElicitationResponse(responseStyle, 'decline', 'denied');
                }
            }
        );

        logger.debug('[CodexMCP] Permission handlers registered');
    }

    /** Extract string field from params */
    private extractString(params: Record<string, unknown>, key: string): string | undefined {
        const value = params[key];
        return typeof value === 'string' && value.length > 0 ? value : undefined;
    }

    /**
     * Build tool input for exec approval (command execution)
     * @param params - Elicitation request params
     * @param cachedAmendment - Cached proposed_execpolicy_amendment from notification
     */
    private buildExecToolInput(
        params: Record<string, unknown>,
        cachedAmendment?: string[]
    ): {
        command: string[];
        cwd?: string;
        parsed_cmd?: unknown[];
        reason?: string;
        proposedExecpolicyAmendment?: string[];
    } {
        // codex_command is the full shell command (e.g., ["/bin/zsh", "-lc", "yarn dev"])
        const command = Array.isArray(params.codex_command)
            ? params.codex_command.filter((p): p is string => typeof p === 'string')
            : [];
        const cwd = this.extractString(params, 'codex_cwd');
        const parsed_cmd = Array.isArray(params.codex_parsed_cmd)
            ? params.codex_parsed_cmd
            : undefined;
        const reason = this.extractString(params, 'codex_reason');

        // Use cached amendment from notification (e.g., ["yarn", "dev"])
        // This is the correct user-friendly command, not the full shell wrapper
        const proposedExecpolicyAmendment = cachedAmendment;

        return { command, cwd, parsed_cmd, reason, proposedExecpolicyAmendment };
    }

    /** Build tool input for patch approval (code changes) */
    private buildPatchToolInput(params: Record<string, unknown>, message: string): {
        message: string;
        reason?: string;
        grantRoot?: string;
        changes?: unknown;
    } {
        const reason = this.extractString(params, 'codex_reason');
        const grantRoot = this.extractString(params, 'codex_grant_root');
        const changes = typeof params.codex_changes === 'object' && params.codex_changes !== null
            ? params.codex_changes
            : undefined;

        return { message, reason, grantRoot, changes };
    }

    /**
     * Map permission handler result to Codex ReviewDecision
     * Both use snake_case (Codex uses #[serde(rename_all = "snake_case")])
     * ExecPolicyAmendment uses #[serde(transparent)] so it's just an array
     */
    private mapResultToDecision(result: {
        decision: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort';
        execPolicyAmendment?: { command: string[] };
    }): ReviewDecision {
        switch (result.decision) {
            case 'approved_execpolicy_amendment':
                if (result.execPolicyAmendment?.command?.length) {
                    return {
                        approved_execpolicy_amendment: {
                            // transparent: directly the array, not { command: [...] }
                            proposed_execpolicy_amendment: result.execPolicyAmendment.command
                        }
                    };
                }
                logger.debug('[CodexMCP] Missing execpolicy amendment, falling back to approved');
                return 'approved';
            case 'approved':
                return 'approved';
            case 'approved_for_session':
                return 'approved_for_session';
            case 'denied':
                return 'denied';
            case 'abort':
                return 'abort';
        }
    }

    /** Map ReviewDecision to ElicitationAction */
    private mapDecisionToAction(decision: ReviewDecision): ElicitationAction {
        if (decision === 'approved' || decision === 'approved_for_session' || isExecpolicyAmendmentDecision(decision)) {
            return 'accept';
        }
        if (decision === 'abort') {
            return 'cancel';
        }
        return 'decline';
    }

    async startSession(config: CodexSessionConfig, options?: { signal?: AbortSignal }): Promise<CodexToolResponse> {
        if (!this.connected) await this.connect();

        logger.debug('[CodexMCP] Starting Codex session:', config);

        const response = await this.client.callTool({
            name: 'codex',
            arguments: config as any
        }, undefined, {
            signal: options?.signal,
            timeout: DEFAULT_TIMEOUT,
            // maxTotalTimeout: 10000000000 
        });

        logger.debug('[CodexMCP] startSession response:', response);

        // Extract session / conversation identifiers from response if present
        this.extractIdentifiers(response);

        return response as CodexToolResponse;
    }

    async continueSession(prompt: string, options?: { signal?: AbortSignal }): Promise<CodexToolResponse> {
        if (!this.connected) await this.connect();

        if (!this.threadId) {
            throw new Error('No active session. Call startSession first.');
        }

        if (!this.conversationId) {
            // Some Codex deployments reuse the thread id as the conversation identifier.
            this.conversationId = this.threadId;
            logger.debug('[CodexMCP] conversationId missing, defaulting to threadId:', this.conversationId);
        }

        const args: Record<string, unknown> = { threadId: this.threadId, prompt };
        if (this.conversationId) {
            args.conversationId = this.conversationId;
        }
        logger.debug('[CodexMCP] Continuing Codex session:', args);

        const response = await this.client.callTool({
            name: 'codex-reply',
            arguments: args
        }, undefined, {
            signal: options?.signal,
            timeout: DEFAULT_TIMEOUT
        });

        logger.debug('[CodexMCP] continueSession response:', response);
        this.extractIdentifiers(response);

        return response as CodexToolResponse;
    }


    private updateIdentifiersFromEvent(event: any): void {
        if (!event || typeof event !== 'object') {
            return;
        }

        const candidates: any[] = [event];
        if (event.data && typeof event.data === 'object') {
            candidates.push(event.data);
        }

        for (const candidate of candidates) {
            const threadId =
                candidate.thread_id
                ?? candidate.threadId
                ?? candidate.session_id
                ?? candidate.sessionId;
            if (threadId) {
                this.threadId = threadId;
                logger.debug('[CodexMCP] Thread ID extracted from event:', this.threadId);
            }

            const conversationId = candidate.conversation_id ?? candidate.conversationId;
            if (conversationId) {
                this.conversationId = conversationId;
                logger.debug('[CodexMCP] Conversation ID extracted from event:', this.conversationId);
            }
        }
    }
    private extractIdentifiers(response: any): void {
        const meta = response?.meta || {};
        const structured =
            response?.structuredContent
            ?? response?.structured_content
            ?? response?.structured_output
            ?? undefined;

        const threadId =
            (structured && typeof structured === 'object' ? (structured as any).threadId ?? (structured as any).thread_id : undefined)
            ?? meta.threadId
            ?? meta.thread_id
            ?? meta.sessionId
            ?? meta.session_id
            ?? response?.threadId
            ?? response?.thread_id
            ?? response?.sessionId
            ?? response?.session_id;
        if (threadId) {
            this.threadId = threadId;
            logger.debug('[CodexMCP] Thread ID extracted:', this.threadId);
        }

        const conversationId =
            (structured && typeof structured === 'object' ? (structured as any).conversationId ?? (structured as any).conversation_id : undefined)
            ?? meta.conversationId
            ?? meta.conversation_id
            ?? response?.conversationId
            ?? response?.conversation_id;
        if (conversationId) {
            this.conversationId = conversationId;
            logger.debug('[CodexMCP] Conversation ID extracted:', this.conversationId);
        }

        const content = response?.content;
        if (Array.isArray(content)) {
            for (const item of content) {
                if (!this.threadId && item?.threadId) {
                    this.threadId = item.threadId;
                    logger.debug('[CodexMCP] Thread ID extracted from content:', this.threadId);
                }
                if (!this.threadId && item?.sessionId) {
                    // Some Codex events still surface the thread id under `sessionId`.
                    this.threadId = item.sessionId;
                    logger.debug('[CodexMCP] Thread ID extracted from content (sessionId):', this.threadId);
                }
                if (!this.conversationId && item && typeof item === 'object' && 'conversationId' in item && item.conversationId) {
                    this.conversationId = item.conversationId;
                    logger.debug('[CodexMCP] Conversation ID extracted from content:', this.conversationId);
                }
            }
        }
    }

    getThreadId(): string | null {
        return this.threadId;
    }

    getSessionId(): string | null {
        // Backwards-compat: our callers historically used "sessionId", but Codex standardizes on "threadId".
        return this.threadId;
    }

    /**
     * Fork-only: seed the MCP client with an existing Codex session id so we can resume
     * with `codex-reply` without relying on transcript files.
     */
    setThreadIdForResume(threadId: string): void {
        this.threadId = threadId;
        // conversationId will be defaulted to threadId on first reply if missing.
        this.conversationId = null;
        logger.debug('[CodexMCP] Session seeded for resume:', this.threadId);
    }

    /**
     * Backwards-compat alias.
     *
     * Prefer `setThreadIdForResume()` (Codex v0.81+).
     */
    setSessionIdForResume(sessionId: string): void {
        this.setThreadIdForResume(sessionId);
    }

    hasActiveSession(): boolean {
        return this.threadId !== null;
    }

    clearSession(): void {
        // Store the previous session ID before clearing for potential resume
        const previousSessionId = this.threadId;
        this.threadId = null;
        this.conversationId = null;
        logger.debug('[CodexMCP] Session cleared, previous sessionId:', previousSessionId);
    }

    /**
     * Store the current session ID without clearing it, useful for abort handling
     */
    storeSessionForResume(): string | null {
        logger.debug('[CodexMCP] Storing session for potential resume:', this.threadId);
        return this.threadId;
    }

    /**
     * Force close the Codex MCP transport and clear all session identifiers.
     * Use this for permanent shutdown (e.g. kill/exit). Prefer `disconnect()` for
     * transient connection resets where you may want to keep the session id.
     */
    async forceCloseSession(): Promise<void> {
        logger.debug('[CodexMCP] Force closing session');
        try {
            await this.disconnect();
        } finally {
            this.clearSession();
        }
        logger.debug('[CodexMCP] Session force-closed');
    }

    async disconnect(): Promise<void> {
        if (!this.connected) return;

        // Capture pid in case we need to force-kill
        const pid = this.transport?.pid ?? null;
        logger.debug(`[CodexMCP] Disconnecting; child pid=${pid ?? 'none'}`);

        try {
            // Ask client to close the transport
            logger.debug('[CodexMCP] client.close begin');
            await this.client.close();
            logger.debug('[CodexMCP] client.close done');
        } catch (e) {
            logger.debug('[CodexMCP] Error closing client, attempting transport close directly', e);
            try { 
                logger.debug('[CodexMCP] transport.close begin');
                await this.transport?.close?.(); 
                logger.debug('[CodexMCP] transport.close done');
            } catch {}
        }

        // As a last resort, if child still exists, send SIGKILL
        if (pid) {
            try {
                process.kill(pid, 0); // check if alive
                logger.debug('[CodexMCP] Child still alive, sending SIGKILL');
                try { process.kill(pid, 'SIGKILL'); } catch {}
            } catch { /* not running */ }
        }

        this.transport = null;
        this.connected = false;
        // Preserve session/conversation identifiers for potential reconnection / recovery flows.
        logger.debug(`[CodexMCP] Disconnected; session ${this.threadId ?? 'none'} preserved`);
    }
}
