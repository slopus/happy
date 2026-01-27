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
} from '@/agent/transport/TransportHandler';
import type { AgentMessage } from '@/agent/core';
import { logger } from '@/ui/logger';
import { filterJsonObjectOrArrayLine } from '@/agent/transport/utils/jsonStdoutFilter';
import {
  findEmptyInputDefaultToolName,
  findToolNameFromId,
  findToolNameFromInputFields,
  isEmptyToolInput,
  type ToolPatternWithInputFields,
} from '@/agent/transport/utils/toolPatternInference';

/**
 * Gemini-specific timeout values (in milliseconds)
 */
export const GEMINI_TIMEOUTS = {
  /** Gemini CLI can be slow on first start (downloading models, etc.) */
  init: 120_000,
  /** Standard tool call timeout */
  toolCall: 120_000,
  /** Investigation tools (codebase_investigator) can run for a long time */
  investigation: 600_000,
  /** Think tools are usually quick */
  think: 30_000,
  /** Idle detection after last message chunk */
  idle: 500,
} as const;

/**
 * Known tool name patterns for Gemini CLI.
 * Used to extract real tool names from toolCallId when Gemini sends "other".
 *
 * Each pattern includes:
 * - name: canonical tool name
 * - patterns: strings to match in toolCallId (case-insensitive)
 * - inputFields: optional fields that indicate this tool when present in input
 * - emptyInputDefault: if true, this tool is the default when input is empty
 */
const GEMINI_TOOL_PATTERNS: ToolPatternWithInputFields[] = [
  {
    name: 'change_title',
    patterns: ['change_title', 'change-title', 'happy__change_title', 'mcp__happy__change_title'],
    inputFields: ['title'],
    emptyInputDefault: true, // change_title often has empty input (title extracted from context)
  },
  {
    name: 'save_memory',
    patterns: ['save_memory', 'save-memory'],
    inputFields: ['memory', 'content'],
  },
  {
    name: 'think',
    patterns: ['think'],
    inputFields: ['thought', 'thinking'],
  },
  // Gemini CLI filesystem / shell tool conventions
  {
    name: 'read',
    patterns: ['read', 'read_file'],
    inputFields: ['filePath', 'file_path', 'path', 'locations'],
  },
  {
    name: 'write',
    patterns: ['write', 'write_file'],
    inputFields: ['filePath', 'file_path', 'path', 'content'],
  },
  {
    name: 'edit',
    patterns: ['edit', 'replace'],
    inputFields: ['oldText', 'newText', 'old_string', 'new_string', 'oldString', 'newString'],
  },
  {
    name: 'execute',
    patterns: ['run_shell_command', 'shell', 'exec', 'bash'],
    inputFields: ['command', 'cmd'],
  },
  {
    name: 'glob',
    patterns: ['glob'],
    inputFields: ['pattern', 'glob'],
  },
  {
    name: 'TodoWrite',
    patterns: ['write_todos', 'todo_write', 'todowrite'],
    inputFields: ['todos', 'items'],
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
    return filterJsonObjectOrArrayLine(line);
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
   * Get idle detection timeout
   */
  getIdleTimeout(): number {
    return GEMINI_TIMEOUTS.idle;
  }

  /**
   * Extract tool name from toolCallId using Gemini patterns.
   *
   * Tool IDs often contain the tool name as a prefix (e.g., "change_title-1765385846663" -> "change_title")
   */
  extractToolNameFromId(toolCallId: string): string | null {
    return findToolNameFromId(toolCallId, GEMINI_TOOL_PATTERNS, { preferLongestMatch: true });
  }

  /**
   * Determine the real tool name from various sources.
   *
   * When Gemini sends "other" or "Unknown tool", tries to determine the real name from:
   * 1. toolCallId patterns (most reliable - tool name often embedded in ID)
   * 2. Input field signatures (specific fields indicate specific tools)
   * 3. Empty input default (some tools like change_title have empty input)
   *
   * Context-based heuristics were removed as they were fragile and the above
   * methods cover all known cases.
   */
  determineToolName(
    toolName: string,
    toolCallId: string,
    input: Record<string, unknown>,
    _context: ToolNameContext
  ): string {
    // 1. Check toolCallId for known tool names (most reliable)
    // Tool IDs often contain the tool name: "change_title-123456" -> "change_title"
    const idToolName = findToolNameFromId(toolCallId, GEMINI_TOOL_PATTERNS, { preferLongestMatch: true });
    if (idToolName) {
      return idToolName;
    }

    // If tool name is already known and not generic, keep it.
    if (toolName !== 'other' && toolName !== 'Unknown tool') {
      return toolName;
    }

    // 2. Check input fields for tool-specific signatures
    const inputFieldToolName = findToolNameFromInputFields(input, GEMINI_TOOL_PATTERNS);
    if (inputFieldToolName) return inputFieldToolName;

    // 3. For empty input, use the default tool (if configured)
    // This handles cases like change_title where the title is extracted from context
    if (toolName === 'other' && isEmptyToolInput(input)) {
      const defaultToolName = findEmptyInputDefaultToolName(GEMINI_TOOL_PATTERNS);
      if (defaultToolName) return defaultToolName;
    }

    // Return original tool name if we couldn't determine it
    // Log unknown patterns so developers can add them to GEMINI_TOOL_PATTERNS
    if (toolName === 'other' || toolName === 'Unknown tool') {
      const inputKeys = input && typeof input === 'object' ? Object.keys(input) : [];
      logger.debug(
        `[GeminiTransport] Unknown tool pattern - toolCallId: "${toolCallId}", ` +
        `toolName: "${toolName}", inputKeys: [${inputKeys.join(', ')}]. ` +
        `Consider adding a new pattern to GEMINI_TOOL_PATTERNS if this tool appears frequently.`
      );
    }

    return toolName;
  }
}

/**
 * Singleton instance for convenience
 */
export const geminiTransport = new GeminiTransport();
