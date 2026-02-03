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
import { logger } from '@/ui/logger';

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
interface ExtendedToolPattern extends ToolPattern {
  /** Fields in input that indicate this tool */
  inputFields?: string[];
  /** If true, this is the default tool when input is empty and toolName is "other" */
  emptyInputDefault?: boolean;
}

const GEMINI_TOOL_PATTERNS: ExtendedToolPattern[] = [
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
   * Check if input is effectively empty
   */
  private isEmptyInput(input: Record<string, unknown> | undefined | null): boolean {
    if (!input) return true;
    if (Array.isArray(input)) return input.length === 0;
    if (typeof input === 'object') return Object.keys(input).length === 0;
    return false;
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
    // If tool name is already known, return it
    if (toolName !== 'other' && toolName !== 'Unknown tool') {
      return toolName;
    }

    // 1. Check toolCallId for known tool names (most reliable)
    // Tool IDs often contain the tool name: "change_title-123456" -> "change_title"
    const idToolName = this.extractToolNameFromId(toolCallId);
    if (idToolName) {
      return idToolName;
    }

    // 2. Check input fields for tool-specific signatures
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      const inputKeys = Object.keys(input);

      for (const toolPattern of GEMINI_TOOL_PATTERNS) {
        if (toolPattern.inputFields) {
          // Check if any input field matches this tool's signature
          const hasMatchingField = toolPattern.inputFields.some((field) =>
            inputKeys.some((key) => key.toLowerCase() === field.toLowerCase())
          );
          if (hasMatchingField) {
            return toolPattern.name;
          }
        }
      }
    }

    // 3. For empty input, use the default tool (if configured)
    // This handles cases like change_title where the title is extracted from context
    if (this.isEmptyInput(input) && toolName === 'other') {
      const defaultTool = GEMINI_TOOL_PATTERNS.find((p) => p.emptyInputDefault);
      if (defaultTool) {
        return defaultTool.name;
      }
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
