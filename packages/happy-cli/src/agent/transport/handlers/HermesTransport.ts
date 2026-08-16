/**
 * Hermes Transport Handler
 *
 * Hermes CLI-specific implementation of TransportHandler.
 * Extends DefaultTransport with:
 * - Hermes tool name patterns (change_title, save_memory, think, HermesReasoning)
 * - Tool name extraction from toolCallId when the name is not reported directly
 *
 * Hermes is an ACP-native agent, so stdout filtering and timeouts follow the
 * defaults; only tool-name resolution needs customization.
 *
 * @module HermesTransport
 */

import { DefaultTransport } from '../DefaultTransport';
import type { ToolPattern } from '../TransportHandler';

/**
 * Known tool name patterns for Hermes CLI.
 *
 * Used to extract real tool names from toolCallId when Hermes does not report
 * the tool name directly. Each pattern lists strings matched against the
 * toolCallId (case-insensitive).
 */
const HERMES_TOOL_PATTERNS: ToolPattern[] = [
  {
    name: 'change_title',
    patterns: ['change_title', 'change-title', 'happy__change_title', 'mcp__happy__change_title'],
  },
  {
    name: 'save_memory',
    patterns: ['save_memory', 'save-memory'],
  },
  {
    name: 'think',
    patterns: ['think'],
  },
  {
    name: 'HermesReasoning',
    patterns: ['hermesreasoning'],
  },
];

/**
 * Hermes CLI transport handler.
 *
 * Inherits default timeouts, stdout filtering, and stderr handling from
 * DefaultTransport; overrides tool-name resolution with Hermes patterns.
 */
export class HermesTransport extends DefaultTransport {
  constructor() {
    super('hermes');
  }

  /**
   * Hermes-specific tool patterns
   */
  getToolPatterns(): ToolPattern[] {
    return HERMES_TOOL_PATTERNS;
  }

  /**
   * Extract tool name from toolCallId using Hermes patterns.
   *
   * Tool IDs often contain the tool name as a substring
   * (e.g. "change_title-1765385846663" -> "change_title").
   */
  extractToolNameFromId(toolCallId: string): string | null {
    const lowerId = toolCallId.toLowerCase();

    for (const toolPattern of HERMES_TOOL_PATTERNS) {
      for (const pattern of toolPattern.patterns) {
        if (lowerId.includes(pattern.toLowerCase())) {
          return toolPattern.name;
        }
      }
    }

    return null;
  }
}

/**
 * Singleton instance for convenience
 */
export const hermesTransport = new HermesTransport();
