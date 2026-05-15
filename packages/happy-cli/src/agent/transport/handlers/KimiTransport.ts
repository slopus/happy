/**
 * Kimi Transport Handler
 *
 * Kimi Code CLI-specific implementation of TransportHandler.
 * Handles:
 * - Standard init timeout (Kimi CLI starts quickly)
 * - Stdout filtering (removes non-JSON output)
 * - Stderr parsing (detects rate limits, auth errors)
 * - Tool name patterns (change_title, think)
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
  /** Kimi CLI starts relatively quickly */
  init: 60_000,
  /** Standard tool call timeout */
  toolCall: 120_000,
  /** Think tools are usually quick */
  think: 30_000,
  /** Idle detection after last message chunk */
  idle: 500,
} as const;

/**
 * Known tool name patterns for Kimi CLI.
 */
const KIMI_TOOL_PATTERNS: ToolPattern[] = [
  {
    name: 'change_title',
    patterns: ['change_title', 'change-title', 'happy__change_title', 'mcp__happy__change_title'],
  },
  {
    name: 'think',
    patterns: ['think'],
  },
];

/**
 * Kimi CLI transport handler.
 *
 * Handles Kimi-specific quirks:
 * - Non-JSON stdout filtering
 * - Rate limit and auth error detection in stderr
 * - Tool name extraction from toolCallId
 */
export class KimiTransport implements TransportHandler {
  readonly agentName = 'kimi';

  /**
   * Kimi CLI init timeout
   */
  getInitTimeout(): number {
    return KIMI_TIMEOUTS.init;
  }

  /**
   * Filter Kimi CLI output from stdout.
   * Only keep valid JSON lines for ACP JSON-RPC parsing.
   */
  filterStdoutLine(line: string): string | null {
    const trimmed = line.trim();

    if (!trimmed) {
      return null;
    }

    // Must start with { or [ to be valid JSON-RPC
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      return null;
    }

    try {
      const parsed = JSON.parse(trimmed);
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
   * - Rate limit errors (429)
   * - Authentication failures
   */
  handleStderr(text: string, _context: StderrContext): StderrResult {
    const trimmed = text.trim();
    if (!trimmed) {
      return { message: null, suppress: true };
    }

    // Rate limit error (429)
    if (
      trimmed.includes('status 429') ||
      trimmed.includes('code":429') ||
      trimmed.includes('rate_limit')
    ) {
      return {
        message: null,
        suppress: false,
      };
    }

    // Authentication error
    if (
      trimmed.includes('401') ||
      trimmed.includes('Unauthorized') ||
      trimmed.includes('invalid_api_key') ||
      trimmed.includes('KIMI_API_KEY')
    ) {
      const errorMessage: AgentMessage = {
        type: 'status',
        status: 'error',
        detail: 'Kimi API authentication failed. Set KIMI_API_KEY environment variable or run `kimi auth`.',
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
   * Get timeout for a tool call
   */
  getToolCallTimeout(toolCallId: string, toolKind?: string): number {
    if (toolKind === 'think') {
      return KIMI_TIMEOUTS.think;
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
   * Determine the real tool name from various sources.
   */
  determineToolName(
    toolName: string,
    toolCallId: string,
    _input: Record<string, unknown>,
    _context: ToolNameContext
  ): string {
    if (toolName !== 'other' && toolName !== 'Unknown tool') {
      return toolName;
    }

    const idToolName = this.extractToolNameFromId(toolCallId);
    if (idToolName) {
      return idToolName;
    }

    if (toolName === 'other' || toolName === 'Unknown tool') {
      logger.debug(
        `[KimiTransport] Unknown tool pattern - toolCallId: "${toolCallId}", toolName: "${toolName}".`
      );
    }

    return toolName;
  }
}

/**
 * Singleton instance for convenience
 */
export const kimiTransport = new KimiTransport();
