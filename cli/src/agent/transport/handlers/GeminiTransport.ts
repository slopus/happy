/**
 * Gemini Transport Handler
 *
 * Gemini CLI-specific implementation of TransportHandler.
 * Handles:
 * - Long init timeout (Gemini CLI is slow on first start)
 * - Stdout filtering (removes debug output that breaks JSON-RPC)
 * - Stderr parsing (detects rate limits, 404 errors)
 * - Tool name patterns (change_title, save_memory, think)
 * - Investigation tool detection (codebase_investigator)
 *
 * @module GeminiTransport
 */

import type {
  TransportHandler,
  ToolPattern,
  StderrContext,
  StderrResult,
  ToolNameContext,
} from '../TransportHandler';
import type { AgentMessage } from '../../core';

/**
 * Gemini-specific timeout values (in milliseconds)
 */
const GEMINI_TIMEOUTS = {
  /** Gemini CLI can be slow on first start (downloading models, etc.) */
  init: 120_000,
  /** Standard tool call timeout */
  toolCall: 120_000,
  /** Investigation tools (codebase_investigator) can run for a long time */
  investigation: 600_000,
  /** Think tools are usually quick */
  think: 30_000,
} as const;

/**
 * Known tool name patterns for Gemini CLI.
 * Used to extract real tool names from toolCallId when Gemini sends "other".
 */
const GEMINI_TOOL_PATTERNS: ToolPattern[] = [
  {
    name: 'change_title',
    patterns: ['change_title', 'change-title', 'happy__change_title'],
  },
  {
    name: 'save_memory',
    patterns: ['save_memory', 'save-memory'],
  },
  {
    name: 'think',
    patterns: ['think'],
  },
];

/**
 * Available Gemini models for error messages
 */
const AVAILABLE_MODELS = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
];

/**
 * Gemini CLI transport handler.
 *
 * Handles all Gemini-specific quirks:
 * - Debug output filtering from stdout
 * - Rate limit and error detection in stderr
 * - Tool name extraction from toolCallId
 */
export class GeminiTransport implements TransportHandler {
  readonly agentName = 'gemini';

  /**
   * Gemini CLI needs 2 minutes for first start (model download, warm-up)
   */
  getInitTimeout(): number {
    return GEMINI_TIMEOUTS.init;
  }

  /**
   * Filter Gemini CLI debug output from stdout.
   *
   * Gemini CLI outputs various debug info (experiments, flags, etc.) to stdout
   * that breaks ACP JSON-RPC parsing. We only keep valid JSON lines.
   */
  filterStdoutLine(line: string): string | null {
    const trimmed = line.trim();

    // Empty lines - skip
    if (!trimmed) {
      return null;
    }

    // Must start with { or [ to be valid JSON-RPC
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      return null;
    }

    // Validate it's actually parseable JSON and is an object (not a primitive)
    // JSON-RPC messages are always objects, but numbers like "105887304" parse as valid JSON
    try {
      const parsed = JSON.parse(trimmed);
      // Must be an object or array (for batched requests), not a primitive
      if (typeof parsed !== 'object' || parsed === null) {
        return null;
      }
      return line;
    } catch {
      return null;
    }
  }

  /**
   * Handle Gemini CLI stderr output.
   *
   * Detects:
   * - Rate limit errors (429) - logged but not shown (CLI handles retries)
   * - Model not found (404) - emit error with available models
   * - Other errors during investigation - logged for debugging
   */
  handleStderr(text: string, context: StderrContext): StderrResult {
    const trimmed = text.trim();
    if (!trimmed) {
      return { message: null, suppress: true };
    }

    // Rate limit error (429) - Gemini CLI handles retries internally
    if (
      trimmed.includes('status 429') ||
      trimmed.includes('code":429') ||
      trimmed.includes('rateLimitExceeded') ||
      trimmed.includes('RESOURCE_EXHAUSTED')
    ) {
      return {
        message: null,
        suppress: false, // Log for debugging but don't show to user
      };
    }

    // Model not found (404) - show error with available models
    if (trimmed.includes('status 404') || trimmed.includes('code":404')) {
      const errorMessage: AgentMessage = {
        type: 'status',
        status: 'error',
        detail: `Model not found. Available models: ${AVAILABLE_MODELS.join(', ')}`,
      };
      return { message: errorMessage };
    }

    // During investigation tools, log any errors/timeouts for debugging
    if (context.hasActiveInvestigation) {
      const hasError =
        trimmed.includes('timeout') ||
        trimmed.includes('Timeout') ||
        trimmed.includes('failed') ||
        trimmed.includes('Failed') ||
        trimmed.includes('error') ||
        trimmed.includes('Error');

      if (hasError) {
        // Just log, don't emit - investigation might recover
        return { message: null, suppress: false };
      }
    }

    return { message: null };
  }

  /**
   * Gemini-specific tool patterns
   */
  getToolPatterns(): ToolPattern[] {
    return GEMINI_TOOL_PATTERNS;
  }

  /**
   * Check if tool is an investigation tool (needs longer timeout)
   */
  isInvestigationTool(toolCallId: string, toolKind?: string): boolean {
    const lowerId = toolCallId.toLowerCase();
    return (
      lowerId.includes('codebase_investigator') ||
      lowerId.includes('investigator') ||
      (typeof toolKind === 'string' && toolKind.includes('investigator'))
    );
  }

  /**
   * Get timeout for a tool call
   */
  getToolCallTimeout(toolCallId: string, toolKind?: string): number {
    if (this.isInvestigationTool(toolCallId, toolKind)) {
      return GEMINI_TIMEOUTS.investigation;
    }
    if (toolKind === 'think') {
      return GEMINI_TIMEOUTS.think;
    }
    return GEMINI_TIMEOUTS.toolCall;
  }

  /**
   * Extract tool name from toolCallId using Gemini patterns.
   *
   * Tool IDs often contain the tool name as a prefix (e.g., "change_title-1765385846663" -> "change_title")
   */
  extractToolNameFromId(toolCallId: string): string | null {
    const lowerId = toolCallId.toLowerCase();

    for (const toolPattern of GEMINI_TOOL_PATTERNS) {
      for (const pattern of toolPattern.patterns) {
        if (lowerId.includes(pattern.toLowerCase())) {
          return toolPattern.name;
        }
      }
    }

    return null;
  }

  /**
   * Determine the real tool name from various sources.
   *
   * When Gemini sends "other" or "Unknown tool", tries to determine the real name from:
   * 1. toolCallId patterns (most reliable)
   * 2. input parameters
   * 3. Context (first tool call after change_title instruction)
   */
  determineToolName(
    toolName: string,
    toolCallId: string,
    input: Record<string, unknown>,
    context: ToolNameContext
  ): string {
    // If tool name is already known, return it
    if (toolName !== 'other' && toolName !== 'Unknown tool') {
      return toolName;
    }

    // 1. Check toolCallId for known tool names (most reliable)
    const idToolName = this.extractToolNameFromId(toolCallId);
    if (idToolName) {
      return idToolName;
    }

    // 2. Check input for function names or tool identifiers
    if (input && typeof input === 'object') {
      const inputStr = JSON.stringify(input).toLowerCase();
      for (const toolPattern of GEMINI_TOOL_PATTERNS) {
        for (const pattern of toolPattern.patterns) {
          if (inputStr.includes(pattern.toLowerCase())) {
            return toolPattern.name;
          }
        }
      }
    }

    // 3. Check if input contains 'title' field - likely change_title
    if (input && typeof input === 'object' && 'title' in input) {
      return 'change_title';
    }

    // 4. Context-based heuristic: if prompt had change_title instruction
    // and tool is "other" with empty input, it's likely change_title
    if (context.recentPromptHadChangeTitle) {
      const isEmptyInput =
        !input ||
        (Array.isArray(input) && input.length === 0) ||
        (typeof input === 'object' && Object.keys(input).length === 0);

      if (isEmptyInput && toolName === 'other') {
        return 'change_title';
      }
    }

    // 5. Fallback: if toolName is "other" with empty input, it's most likely change_title
    // This is because change_title is the only MCP tool that:
    // - Gets reported as "other" by Gemini ACP
    // - Has empty input (title is extracted from context, not passed as input)
    const isEmptyInput =
      !input ||
      (Array.isArray(input) && input.length === 0) ||
      (typeof input === 'object' && Object.keys(input).length === 0);

    if (isEmptyInput && toolName === 'other') {
      return 'change_title';
    }

    // Return original tool name if we couldn't determine it
    return toolName;
  }
}

/**
 * Singleton instance for convenience
 */
export const geminiTransport = new GeminiTransport();
