/**
 * AgentBackend - Universal interface for AI agent backends
 * 
 * This module defines the core abstraction for different agent backends
 * (Claude, Codex, Gemini, OpenCode, etc.) that can be controlled through
 * the Happy CLI and mobile app.
 * 
 * The AgentBackend interface provides a unified way to:
 * - Start and manage agent sessions
 * - Send prompts and receive responses
 * - Handle tool calls and permissions
 * - Stream model output and events
 */

import type { AgentId as CatalogAgentId } from '@happy/agents';

/** Unique identifier for an agent session */
export type SessionId = string;

/** Unique identifier for a tool call */
export type ToolCallId = string;

/**
 * Messages emitted by an agent backend during a session.
 * These messages are forwarded to the Happy server and mobile app.
 */
export type AgentMessage =
  | { type: 'model-output'; textDelta?: string; fullText?: string }
  | { type: 'status'; status: 'starting' | 'running' | 'idle' | 'stopped' | 'error'; detail?: string }
  | { type: 'tool-call'; toolName: string; args: Record<string, unknown>; callId: ToolCallId }
  | { type: 'tool-result'; toolName: string; result: unknown; callId: ToolCallId }
  | { type: 'permission-request'; id: string; reason: string; payload: unknown }
  | { type: 'permission-response'; id: string; approved: boolean }
  | { type: 'fs-edit'; description: string; diff?: string; path?: string }
  | { type: 'terminal-output'; data: string }
  | { type: 'event'; name: string; payload: unknown }
  | { type: 'token-count'; [key: string]: unknown } // Token count information (format may vary)
  | { type: 'exec-approval-request'; call_id: string; [key: string]: unknown } // Exec approval request (like Codex exec_approval_request)
  | { type: 'patch-apply-begin'; call_id: string; auto_approved?: boolean; changes: Record<string, unknown> } // Patch operation begin (like Codex patch_apply_begin)
  | { type: 'patch-apply-end'; call_id: string; stdout?: string; stderr?: string; success: boolean } // Patch operation end (like Codex patch_apply_end)

/** MCP server configuration for tools */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Transport type for agent communication */
export type AgentTransport = 'native-claude' | 'mcp-codex' | 'acp';

/** Agent identifier */
export type AgentId = CatalogAgentId;

/**
 * Configuration for creating an agent backend
 */
export interface AgentBackendConfig {
  /** Working directory for the agent */
  cwd: string;
  
  /** Name of the agent */
  agentName: AgentId;
  
  /** Transport protocol to use */
  transport: AgentTransport;
  
  /** Environment variables to pass to the agent */
  env?: Record<string, string>;
  
  /** MCP servers to make available to the agent */
  mcpServers?: Record<string, McpServerConfig>;
}

/**
 * Configuration specific to ACP-based agents
 */
export interface AcpAgentConfig extends AgentBackendConfig {
  transport: 'acp';
  
  /** Command to spawn the ACP agent */
  command: string;
  
  /** Arguments for the agent command */
  args?: string[];
}

/**
 * Result of starting a session
 */
export interface StartSessionResult {
  sessionId: SessionId;
}

/**
 * Handler function type for agent messages
 */
export type AgentMessageHandler = (msg: AgentMessage) => void;

/**
 * Universal interface for agent backends.
 * 
 * All agent implementations (Claude, Codex, Gemini, etc.) should implement
 * this interface to be usable through the Happy CLI and mobile app.
 */
export interface AgentBackend {
  /**
   * Start a new agent session.
   * 
   * @param initialPrompt - Optional initial prompt to send to the agent
   * @returns Promise resolving to session information
   */
  startSession(initialPrompt?: string): Promise<StartSessionResult>;

  /**
   * Load an existing agent session (vendor-level resume).
   *
   * Not all agents support this. ACP agents may advertise this capability
   * via the protocol (e.g. Codex ACP).
   *
   * When unsupported, callers should fall back to starting a new session.
   */
  loadSession?(sessionId: SessionId): Promise<StartSessionResult>;

  /**
   * Load an existing agent session and capture the replayed history.
   *
   * ACP agents that implement session/load may replay the full conversation via session/update.
   * This hook allows Happy CLI to capture that replay and import it into the Happy transcript.
   */
  loadSessionWithReplayCapture?(sessionId: SessionId): Promise<StartSessionResult & { replay: unknown[] }>;
  
  /**
   * Send a prompt to an existing session.
   * 
   * @param sessionId - The session to send the prompt to
   * @param prompt - The user's prompt text
   */
  sendPrompt(sessionId: SessionId, prompt: string): Promise<void>;
  
  /**
   * Cancel the current operation in a session.
   * 
   * @param sessionId - The session to cancel
   */
  cancel(sessionId: SessionId): Promise<void>;
  
  /**
   * Register a handler for agent messages.
   * 
   * @param handler - Function to call when messages are received
   */
  onMessage(handler: AgentMessageHandler): void;
  
  /**
   * Remove a previously registered message handler.
   * 
   * @param handler - The handler to remove
   */
  offMessage?(handler: AgentMessageHandler): void;
  
  /**
   * Respond to a permission request.
   *
   * **Implementation Note for ACP backends:**
   * For ACP-based agents (Gemini, Codex via ACP), permission handling is done
   * synchronously within the `requestPermission` RPC handler via `AcpPermissionHandler`.
   * This method only emits an internal `permission-response` event for UI/logging purposes.
   * The actual ACP response is already sent by the time this method is called.
   *
   * For non-ACP backends, this method should actually send the permission response
   * to the agent.
   *
   * @param requestId - The ID of the permission request
   * @param approved - Whether the permission was granted
   */
  respondToPermission?(requestId: string, approved: boolean): Promise<void>;
  
  /**
   * Wait for the current response to complete.
   * Call this after sendPrompt to wait for all chunks to be received.
   * 
   * @param timeoutMs - Maximum time to wait in milliseconds (default: 120000)
   */
  waitForResponseComplete?(timeoutMs?: number): Promise<void>;
  
  /**
   * Clean up resources and close the backend.
   */
  dispose(): Promise<void>;
}
