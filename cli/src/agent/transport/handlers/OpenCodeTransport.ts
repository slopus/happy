/**
 * OpenCode Transport Handler
 *
 * OpenCode CLI-specific implementation of TransportHandler.
 * Handles:
 * - Init timeout (OpenCode starts quickly)
 * - Stdout filtering (removes debug output that breaks JSON-RPC)
 * - Stderr parsing (detects rate limits, errors)
 * - Tool name patterns (change_title, think, etc.)
 *
 * @module OpenCodeTransport
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
 * OpenCode-specific timeout values (in milliseconds)
 */
export const OPENCODE_TIMEOUTS = {
  /** OpenCode needs time to load plugins (bun install, etc.) */
  init: 120_000,
  /** Standard tool call timeout */
  toolCall: 120_000,
  /** Long-running tools (file operations, searches) */
  longRunning: 300_000,
  /** Think tools are usually quick */
  think: 30_000,
  /** Idle detection after last message chunk */
  idle: 500,
} as const;

/**
 * Known tool name patterns for OpenCode CLI.
 * Used to extract real tool names from toolCallId when OpenCode sends "other".
 */
interface ExtendedToolPattern extends ToolPattern {
  /** Fields in input that indicate this tool */
  inputFields?: string[];
  /** If true, this is the default tool when input is empty and toolName is "other" */
  emptyInputDefault?: boolean;
}

const OPENCODE_TOOL_PATTERNS: ExtendedToolPattern[] = [
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
  {
    name: 'read',
    patterns: ['read', 'mcp_read'],
    inputFields: ['filePath', 'path'],
  },
  {
    name: 'write',
    patterns: ['write', 'mcp_write'],
    inputFields: ['filePath', 'content'],
  },
  {
    name: 'edit',
    patterns: ['edit', 'mcp_edit'],
    inputFields: ['oldString', 'newString'],
  },
  {
    name: 'bash',
    patterns: ['bash', 'mcp_bash'],
    inputFields: ['command'],
  },
  {
    name: 'glob',
    patterns: ['glob', 'mcp_glob'],
    inputFields: ['pattern'],
  },
  {
    name: 'grep',
    patterns: ['grep', 'mcp_grep'],
    inputFields: ['pattern', 'include'],
  },
];

/**
 * OpenCode CLI transport handler.
 *
 * Handles all OpenCode-specific quirks:
 * - Debug output filtering from stdout
 * - Rate limit and error detection in stderr
 * - Tool name extraction from toolCallId
 */
export class OpenCodeTransport implements TransportHandler {
  readonly agentName = 'opencode';

  /**
   * OpenCode starts fairly quickly
   */
  getInitTimeout(): number {
    return OPENCODE_TIMEOUTS.init;
  }

  /**
   * Filter OpenCode CLI debug output from stdout.
   *
   * OpenCode outputs many log messages to stdout that break JSON-RPC parsing.
   * We only keep valid JSON-RPC lines.
   */
  filterStdoutLine(line: string): string | null {
    const trimmed = line.trim();

    // Empty lines - skip
    if (!trimmed) {
      return null;
    }

    // Skip INFO/DEBUG/WARN/ERROR log lines (OpenCode format: "INFO  2026-01-27...")
    if (trimmed.startsWith('INFO') || trimmed.startsWith('DEBUG') || 
        trimmed.startsWith('WARN') || trimmed.startsWith('ERROR')) {
      return null;
    }

    // Skip service= log lines (OpenCode internal logs)
    if (trimmed.includes('service=')) {
      return null;
    }

    // Skip bun output lines
    if (trimmed.startsWith('bun ') || trimmed.includes('bun install') || 
        trimmed.includes('bun add') || trimmed.includes('[') && trimmed.includes('ms]')) {
      return null;
    }

    // Skip plugin loading messages
    if (trimmed.includes('loading plugin') || trimmed.includes('loading internal plugin')) {
      return null;
    }

    // Skip "Saved lockfile" and similar messages
    if (trimmed.includes('Saved lockfile') || trimmed.includes('installed @')) {
      return null;
    }

    // Must start with { or [ to be valid JSON-RPC
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      return null;
    }

    // Validate it's actually parseable JSON and is an object (not a primitive)
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
   * Handle OpenCode CLI stderr output.
   *
   * Detects:
   * - Rate limit errors (429)
   * - API errors
   * - Other errors during execution
   */
  handleStderr(text: string, context: StderrContext): StderrResult {
    const trimmed = text.trim();
    if (!trimmed) {
      return { message: null, suppress: true };
    }

    // Rate limit error (429)
    if (
      trimmed.includes('status 429') ||
      trimmed.includes('code":429') ||
      trimmed.includes('rateLimitExceeded') ||
      trimmed.includes('rate_limit')
    ) {
      return {
        message: null,
        suppress: false,
      };
    }

    // Authentication error
    if (trimmed.includes('401') || trimmed.includes('unauthorized') || trimmed.includes('Unauthorized')) {
      const errorMessage: AgentMessage = {
        type: 'status',
        status: 'error',
        detail: 'Authentication failed. Please check your API key.',
      };
      return { message: errorMessage };
    }

    // Model not found
    if (trimmed.includes('404') || trimmed.includes('not found')) {
      const errorMessage: AgentMessage = {
        type: 'status',
        status: 'error',
        detail: 'Model not found. Check your model configuration.',
      };
      return { message: errorMessage };
    }

    // Log other errors for debugging
    if (context.hasActiveInvestigation) {
      const hasError =
        trimmed.includes('timeout') ||
        trimmed.includes('Timeout') ||
        trimmed.includes('failed') ||
        trimmed.includes('Failed') ||
        trimmed.includes('error') ||
        trimmed.includes('Error');

      if (hasError) {
        return { message: null, suppress: false };
      }
    }

    return { message: null };
  }

  /**
   * OpenCode-specific tool patterns
   */
  getToolPatterns(): ToolPattern[] {
    return OPENCODE_TOOL_PATTERNS;
  }

  /**
   * Check if tool is a long-running tool (needs longer timeout)
   */
  isInvestigationTool(toolCallId: string, toolKind?: string): boolean {
    const lowerId = toolCallId.toLowerCase();
    return (
      lowerId.includes('search') ||
      lowerId.includes('grep') ||
      lowerId.includes('glob') ||
      lowerId.includes('task') ||
      (typeof toolKind === 'string' && toolKind.includes('search'))
    );
  }

  /**
   * Get timeout for a tool call
   */
  getToolCallTimeout(toolCallId: string, toolKind?: string): number {
    if (this.isInvestigationTool(toolCallId, toolKind)) {
      return OPENCODE_TIMEOUTS.longRunning;
    }
    if (toolKind === 'think') {
      return OPENCODE_TIMEOUTS.think;
    }
    return OPENCODE_TIMEOUTS.toolCall;
  }

  /**
   * Get idle detection timeout
   */
  getIdleTimeout(): number {
    return OPENCODE_TIMEOUTS.idle;
  }

  /**
   * Extract tool name from toolCallId using OpenCode patterns.
   */
  extractToolNameFromId(toolCallId: string): string | null {
    const lowerId = toolCallId.toLowerCase();

    for (const toolPattern of OPENCODE_TOOL_PATTERNS) {
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

      for (const toolPattern of OPENCODE_TOOL_PATTERNS) {
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
      const defaultTool = OPENCODE_TOOL_PATTERNS.find((p) => p.emptyInputDefault);
      if (defaultTool) {
        return defaultTool.name;
      }
    }

    // Log unknown patterns for debugging
    if (toolName === 'other' || toolName === 'Unknown tool') {
      const inputKeys = input && typeof input === 'object' ? Object.keys(input) : [];
      logger.debug(
        `[OpenCodeTransport] Unknown tool pattern - toolCallId: "${toolCallId}", ` +
        `toolName: "${toolName}", inputKeys: [${inputKeys.join(', ')}].`
      );
    }

    return toolName;
  }
}

/**
 * Singleton instance for convenience
 */
export const openCodeTransport = new OpenCodeTransport();
