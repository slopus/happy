/**
 * TransportHandler Interface
 *
 * Abstraction layer for agent-specific transport logic.
 * Allows different ACP agents (Gemini, Codex, Claude, etc.) to customize:
 * - Initialization timeouts
 * - Stdout filtering (for debug output removal)
 * - Stderr handling (for error detection)
 * - Tool name patterns
 *
 * @module TransportHandler
 */

import type { AgentMessage } from '../core';

/**
 * Tool name pattern for extraction from toolCallId
 */
export interface ToolPattern {
  /** Canonical tool name */
  name: string;
  /** Patterns to match in toolCallId (case-insensitive) */
  patterns: string[];
}

/**
 * Context passed to stderr handler
 */
export interface StderrContext {
  /** Currently active tool calls */
  activeToolCalls: Set<string>;
  /** Whether any active tool is an investigation tool */
  hasActiveInvestigation: boolean;
}

/**
 * Context for tool name detection heuristics
 */
export interface ToolNameContext {
  /** Whether the recent prompt contained change_title instruction */
  recentPromptHadChangeTitle: boolean;
  /** Number of tool calls since last prompt */
  toolCallCountSincePrompt: number;
}

/**
 * Result of stderr processing
 */
export interface StderrResult {
  /** Message to emit (null = don't emit anything) */
  message: AgentMessage | null;
  /** Whether to suppress this stderr line from logs */
  suppress?: boolean;
}

/**
 * Transport handler interface for ACP backends.
 *
 * Implement this interface to customize behavior for specific agents.
 * Use DefaultTransport as a base or reference implementation.
 */
export interface TransportHandler {
  /**
   * Agent identifier for logging
   */
  readonly agentName: string;

  /**
   * Get initialization timeout in milliseconds.
   *
   * Different agents have different startup times:
   * - Gemini CLI: 120s (slow on first start, downloads models)
   * - Codex: ~30s
   * - Claude: ~10s
   *
   * @returns Timeout in milliseconds
   */
  getInitTimeout(): number;

  /**
   * Filter a line from stdout before ACP parsing.
   *
   * Some agents output debug info to stdout that breaks JSON-RPC parsing.
   * Return null to drop the line, or the (possibly modified) line to keep it.
   *
   * @param line - Raw line from stdout
   * @returns Filtered line or null to drop
   */
  filterStdoutLine?(line: string): string | null;

  /**
   * Handle stderr output from the agent process.
   *
   * Used to detect errors (rate limits, auth failures, etc.) and
   * optionally emit status messages to the UI.
   *
   * @param text - Stderr text
   * @param context - Context about current state
   * @returns Result with optional message to emit
   */
  handleStderr?(text: string, context: StderrContext): StderrResult;

  /**
   * Get tool name patterns for this agent.
   *
   * Used to extract real tool names from toolCallId when the agent
   * sends "other" or "unknown" as the tool name.
   *
   * @returns Array of tool patterns
   */
  getToolPatterns(): ToolPattern[];

  /**
   * Check if a tool is an "investigation" tool that needs longer timeout.
   *
   * Investigation tools (like codebase_investigator) can run for minutes
   * and need special timeout handling.
   *
   * @param toolCallId - The tool call ID
   * @param toolKind - The tool kind/type
   * @returns true if this is an investigation tool
   */
  isInvestigationTool?(toolCallId: string, toolKind?: string): boolean;

  /**
   * Get timeout for a specific tool call.
   *
   * @param toolCallId - The tool call ID
   * @param toolKind - The tool kind/type
   * @returns Timeout in milliseconds
   */
  getToolCallTimeout?(toolCallId: string, toolKind?: string): number;

  /**
   * Extract tool name from toolCallId.
   *
   * Tool IDs often contain the tool name as a prefix (e.g., "change_title-123" -> "change_title").
   * Uses getToolPatterns() to match known patterns.
   *
   * @param toolCallId - The tool call ID
   * @returns The extracted tool name, or null if not found
   */
  extractToolNameFromId?(toolCallId: string): string | null;

  /**
   * Determine the real tool name from various sources.
   *
   * When the agent sends "other" or "Unknown tool", tries to determine the real name from:
   * 1. toolCallId patterns
   * 2. input parameters
   * 3. Context (first tool call after change_title instruction)
   *
   * @param toolName - The initial tool name (may be "other" or "Unknown tool")
   * @param toolCallId - The tool call ID
   * @param input - The input parameters
   * @param context - Context information
   * @returns The determined tool name
   */
  determineToolName?(
    toolName: string,
    toolCallId: string,
    input: Record<string, unknown>,
    context: ToolNameContext
  ): string;

  /**
   * Get idle detection timeout in milliseconds.
   *
   * This timeout is used to detect when the agent has finished producing output
   * and is ready for the next prompt. After no chunks arrive for this duration,
   * the backend emits 'idle' status.
   *
   * @returns Timeout in milliseconds (default: 500)
   */
  getIdleTimeout?(): number;
}
