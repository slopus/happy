/**
 * Default Transport Handler
 *
 * Basic implementation of TransportHandler with reasonable defaults.
 * Use this for agents that don't need special filtering or error handling.
 *
 * @module DefaultTransport
 */

import type {
  TransportHandler,
  ToolPattern,
  StderrContext,
  StderrResult,
  ToolNameContext,
} from './TransportHandler';
import { filterJsonObjectOrArrayLine } from './utils/jsonStdoutFilter';

/**
 * Default timeout values (in milliseconds)
 */
const DEFAULT_TIMEOUTS = {
  /** Default initialization timeout: 60 seconds */
  init: 60_000,
  /** Default tool call timeout: 2 minutes */
  toolCall: 120_000,
  /** Investigation tool timeout: 10 minutes */
  investigation: 600_000,
  /** Think tool timeout: 30 seconds */
  think: 30_000,
} as const;

/**
 * Default transport handler implementation.
 *
 * Provides:
 * - 60s init timeout
 * - No stdout filtering (pass through all lines)
 * - Basic stderr logging (no special error detection)
 * - Empty tool patterns (no special tool name extraction)
 * - Standard tool call timeouts
 */
export class DefaultTransport implements TransportHandler {
  readonly agentName: string;

  constructor(agentName: string = 'generic-acp') {
    this.agentName = agentName;
  }

  /**
   * Default init timeout: 60 seconds
   */
  getInitTimeout(): number {
    return DEFAULT_TIMEOUTS.init;
  }

  /**
   * Default: pass through all lines that are valid JSON objects/arrays
   */
  filterStdoutLine(line: string): string | null {
    return filterJsonObjectOrArrayLine(line);
  }

  /**
   * Default: no special stderr handling
   */
  handleStderr(_text: string, _context: StderrContext): StderrResult {
    return { message: null };
  }

  /**
   * Default: no special tool patterns
   */
  getToolPatterns(): ToolPattern[] {
    return [];
  }

  /**
   * Default: no investigation tools
   */
  isInvestigationTool(_toolCallId: string, _toolKind?: string): boolean {
    return false;
  }

  /**
   * Default tool call timeout based on tool kind
   */
  getToolCallTimeout(_toolCallId: string, toolKind?: string): number {
    if (toolKind === 'think') {
      return DEFAULT_TIMEOUTS.think;
    }
    return DEFAULT_TIMEOUTS.toolCall;
  }

  /**
   * Default: no tool name extraction (return null)
   */
  extractToolNameFromId(_toolCallId: string): string | null {
    return null;
  }

  /**
   * Default: return original tool name (no special detection)
   */
  determineToolName(
    toolName: string,
    _toolCallId: string,
    _input: Record<string, unknown>,
    _context: ToolNameContext
  ): string {
    return toolName;
  }
}

/**
 * Singleton instance for convenience
 */
export const defaultTransport = new DefaultTransport();
