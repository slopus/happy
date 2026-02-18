/**
 * Kimi Transport Handler
 *
 * Kimi CLI-specific implementation of TransportHandler.
 * Handles:
 * - Stdout filtering (removes debug output that breaks JSON-RPC)
 * - Stderr parsing (detects auth failures, rate limits)
 * - Tool name patterns
 * - Kimi-specific timeouts
 *
 * @module KimiTransport
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
 * Kimi-specific timeout values (in milliseconds)
 */
export const KIMI_TIMEOUTS = {
  /** Kimi CLI initialization timeout */
  init: 60_000,
  /** Standard tool call timeout */
  toolCall: 120_000,
  /** Long-running tools (file search, etc.) */
  longRunning: 300_000,
  /** Idle detection after last message chunk */
  idle: 500,
} as const;

/**
 * Known tool name patterns for Kimi CLI.
 * Used to extract real tool names from toolCallId when Kimi sends generic names.
 */
interface ExtendedToolPattern extends ToolPattern {
  /** Fields in input that indicate this tool */
  inputFields?: string[];
  /** If true, this is the default tool when input is empty */
  emptyInputDefault?: boolean;
}

const KIMI_TOOL_PATTERNS: ExtendedToolPattern[] = [
  {
    name: 'change_title',
    patterns: ['change_title', 'change-title', 'happy__change_title', 'mcp__happy__change_title'],
    inputFields: ['title'],
    emptyInputDefault: true,
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
  // Kimi built-in tools
  {
    name: 'read_file',
    patterns: ['read_file', 'read-file', 'file_read'],
    inputFields: ['file_path', 'path', 'offset', 'limit'],
  },
  {
    name: 'write_file',
    patterns: ['write_file', 'write-file', 'file_write'],
    inputFields: ['file_path', 'path', 'content'],
  },
  {
    name: 'search_files',
    patterns: ['search_files', 'search-files', 'grep', 'ripgrep'],
    inputFields: ['path', 'regex', 'pattern'],
  },
  {
    name: 'execute_command',
    patterns: ['execute_command', 'execute-command', 'bash', 'shell', 'exec'],
    inputFields: ['command', 'cmd', 'shell'],
  },
];

/**
 * Kimi CLI transport handler.
 *
 * Handles Kimi-specific behavior for ACP communication.
 */
export class KimiTransport implements TransportHandler {
  readonly agentName = 'kimi';

  /**
   * Kimi CLI initialization timeout
   */
  getInitTimeout(): number {
    return KIMI_TIMEOUTS.init;
  }

  /**
   * Filter Kimi CLI debug output from stdout.
   *
   * Kimi CLI may output debug info to stdout that breaks ACP JSON-RPC parsing.
   * We only keep valid JSON lines.
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

    // Validate it's actually parseable JSON and is an object
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
   * Handle Kimi CLI stderr output.
   *
   * Detects:
   * - Auth failures (not logged in)
   * - Rate limit errors
   * - Other errors
   */
  handleStderr(text: string, _context: StderrContext): StderrResult {
    const trimmed = text.trim();
    if (!trimmed) {
      return { message: null, suppress: true };
    }

    // Auth failure - need to login
    if (
      trimmed.includes('not logged in') ||
      trimmed.includes('authentication required') ||
      trimmed.includes('401') ||
      trimmed.includes('Unauthorized')
    ) {
      const errorMessage: AgentMessage = {
        type: 'status',
        status: 'error',
        detail: 'Not authenticated. Please run "kimi login" first.',
      };
      return { message: errorMessage };
    }

    // Rate limit error
    if (
      trimmed.includes('status 429') ||
      trimmed.includes('code":429') ||
      trimmed.includes('rateLimitExceeded') ||
      trimmed.includes('RATE_LIMIT') ||
      trimmed.includes('too many requests')
    ) {
      return {
        message: null,
        suppress: false, // Log for debugging
      };
    }

    // Model not found
    if (trimmed.includes('model') && (trimmed.includes('not found') || trimmed.includes('404'))) {
      const errorMessage: AgentMessage = {
        type: 'status',
        status: 'error',
        detail: `Model not found or not available.`,
      };
      return { message: errorMessage };
    }

    return { message: null };
  }

  /**
   * Kimi-specific tool patterns
   */
  getToolPatterns(): ToolPattern[] {
    return KIMI_TOOL_PATTERNS;
  }

  /**
   * Check if tool is a long-running tool (needs longer timeout)
   */
  isLongRunningTool(toolCallId: string, toolKind?: string): boolean {
    const lowerId = toolCallId.toLowerCase();
    return (
      lowerId.includes('search') ||
      lowerId.includes('grep') ||
      lowerId.includes('find') ||
      (typeof toolKind === 'string' &&
        (toolKind.includes('search') || toolKind.includes('grep')))
    );
  }

  /**
   * Get timeout for a tool call
   */
  getToolCallTimeout(toolCallId: string, toolKind?: string): number {
    if (this.isLongRunningTool(toolCallId, toolKind)) {
      return KIMI_TIMEOUTS.longRunning;
    }
    return KIMI_TIMEOUTS.toolCall;
  }

  /**
   * Get idle detection timeout
   */
  getIdleTimeout(): number {
    return KIMI_TIMEOUTS.idle;
  }

  /**
   * Extract tool name from toolCallId using Kimi patterns.
   */
  extractToolNameFromId(toolCallId: string): string | null {
    const lowerId = toolCallId.toLowerCase();

    for (const toolPattern of KIMI_TOOL_PATTERNS) {
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

    // 1. Check toolCallId for known tool names
    const idToolName = this.extractToolNameFromId(toolCallId);
    if (idToolName) {
      return idToolName;
    }

    // 2. Check input fields for tool-specific signatures
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      const inputKeys = Object.keys(input);

      for (const toolPattern of KIMI_TOOL_PATTERNS) {
        if (toolPattern.inputFields) {
          const hasMatchingField = toolPattern.inputFields.some((field) =>
            inputKeys.some((key) => key.toLowerCase() === field.toLowerCase())
          );
          if (hasMatchingField) {
            return toolPattern.name;
          }
        }
      }
    }

    // 3. For empty input, use the default tool
    if (this.isEmptyInput(input) && toolName === 'other') {
      const defaultTool = KIMI_TOOL_PATTERNS.find((p) => p.emptyInputDefault);
      if (defaultTool) {
        return defaultTool.name;
      }
    }

    // Log unknown patterns
    if (toolName === 'other' || toolName === 'Unknown tool') {
      const inputKeys = input && typeof input === 'object' ? Object.keys(input) : [];
      logger.debug(
        `[KimiTransport] Unknown tool pattern - toolCallId: "${toolCallId}", ` +
        `toolName: "${toolName}", inputKeys: [${inputKeys.join(', ')}]. `
      );
    }

    return toolName;
  }
}

/**
 * Singleton instance for convenience
 */
export const kimiTransport = new KimiTransport();
