/**
 * OpenCode Transport Handler
 *
 * OpenCode CLI-specific implementation of TransportHandler.
 * Handles:
 * - Init timeout (OpenCode should start relatively quickly)
 * - Stdout filtering (removes any debug output that breaks JSON-RPC)
 * - Stderr parsing (detects rate limits, auth errors, model errors)
 * - Tool name patterns (change_title, save_memory, think)
 *
 * @module OpencodeTransport
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
  /** OpenCode should start quickly, but give it time for first run */
  init: 60_000,
  /** Standard tool call timeout */
  toolCall: 120_000,
  /** Investigation/search tools can run longer */
  investigation: 300_000,
  /** Think tools are usually quick */
  think: 30_000,
  /** Idle detection after last message chunk */
  idle: 500,
} as const;

/**
 * Known tool name patterns for OpenCode.
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
  // OpenCode-specific tools
  {
    name: 'read',
    patterns: ['read', 'read_file'],
    inputFields: ['filePath', 'path'],
  },
  {
    name: 'write',
    patterns: ['write', 'write_file'],
    inputFields: ['content', 'filePath'],
  },
  {
    name: 'edit',
    patterns: ['edit'],
    inputFields: ['oldString', 'newString'],
  },
  {
    name: 'bash',
    patterns: ['bash', 'shell', 'exec'],
    inputFields: ['command'],
  },
  {
    name: 'glob',
    patterns: ['glob'],
    inputFields: ['pattern'],
  },
  {
    name: 'grep',
    patterns: ['grep'],
    inputFields: ['pattern', 'include'],
  },
  {
    name: 'task',
    patterns: ['task'],
    inputFields: ['prompt', 'subagent_type'],
  },
];

/**
 * OpenCode transport handler.
 *
 * Handles all OpenCode-specific quirks:
 * - Debug output filtering from stdout
 * - Error detection in stderr
 * - Tool name extraction from toolCallId
 */
export class OpencodeTransport implements TransportHandler {
  readonly agentName = 'opencode';

  /**
   * OpenCode should start relatively quickly
   */
  getInitTimeout(): number {
    return OPENCODE_TIMEOUTS.init;
  }

  /**
   * Filter OpenCode debug output from stdout.
   *
   * OpenCode outputs various debug info to stdout that can break ACP JSON-RPC parsing.
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
      if (typeof parsed !== 'object' || parsed === null) {
        return null;
      }
      return line;
    } catch {
      return null;
    }
  }

  /**
   * Handle OpenCode stderr output.
   *
   * Detects:
   * - Rate limit errors (429)
   * - Authentication errors
   * - Model not found errors
   */
  handleStderr(text: string, context: StderrContext): StderrResult {
    const trimmed = text.trim();
    if (!trimmed) {
      return { message: null, suppress: true };
    }

    // Rate limit error (429)
    if (
      trimmed.includes('429') ||
      trimmed.includes('rate limit') ||
      trimmed.includes('Rate limit') ||
      trimmed.includes('RATE_LIMIT')
    ) {
      return {
        message: null,
        suppress: false, // Log for debugging but don't show to user
      };
    }

    // Authentication error
    if (
      trimmed.includes('authentication') ||
      trimmed.includes('Authentication') ||
      trimmed.includes('unauthorized') ||
      trimmed.includes('Unauthorized') ||
      trimmed.includes('API key')
    ) {
      const errorMessage: AgentMessage = {
        type: 'status',
        status: 'error',
        detail: 'Authentication error. Run `opencode auth login` to configure API keys.',
      };
      return { message: errorMessage };
    }

    // Model not found
    if (trimmed.includes('model not found') || trimmed.includes('Model not found')) {
      const errorMessage: AgentMessage = {
        type: 'status',
        status: 'error',
        detail: 'Model not found. Check available models with `opencode models`.',
      };
      return { message: errorMessage };
    }

    // During investigation tools, log any errors for debugging
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
   * Check if tool is an investigation/task tool (needs longer timeout)
   */
  isInvestigationTool(toolCallId: string, toolKind?: string): boolean {
    const lowerId = toolCallId.toLowerCase();
    return (
      lowerId.includes('task') ||
      lowerId.includes('explore') ||
      (typeof toolKind === 'string' && toolKind.includes('task'))
    );
  }

  /**
   * Get timeout for a tool call
   */
  getToolCallTimeout(toolCallId: string, toolKind?: string): number {
    if (this.isInvestigationTool(toolCallId, toolKind)) {
      return OPENCODE_TIMEOUTS.investigation;
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

    // 3. For empty input, use the default tool (if configured)
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
        `[OpencodeTransport] Unknown tool pattern - toolCallId: "${toolCallId}", ` +
        `toolName: "${toolName}", inputKeys: [${inputKeys.join(', ')}]. ` +
        `Consider adding a new pattern to OPENCODE_TOOL_PATTERNS.`
      );
    }

    return toolName;
  }
}

/**
 * Singleton instance for convenience
 */
export const opencodeTransport = new OpencodeTransport();
