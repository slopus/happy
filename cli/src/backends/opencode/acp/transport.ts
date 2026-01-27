/**
 * OpenCode Transport Handler
 *
 * Minimal TransportHandler for OpenCode's ACP mode.
 *
 * OpenCode ACP is expected to speak JSON-RPC over ndJSON on stdout.
 * This transport focuses on:
 * - Conservative stdout filtering (JSON objects/arrays only)
 * - Reasonable init/tool timeouts
 * - Heuristics for mapping OpenCode "other" tool names to concrete tool names
 * - Basic stderr classification (auth/model errors)
 *
 * Agent-specific stderr parsing can be added later if needed.
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
  findToolNameFromId,
  findToolNameFromInputFields,
  type ToolPatternWithInputFields,
} from '@/agent/transport/utils/toolPatternInference';

export const OPENCODE_TIMEOUTS = {
  /**
   * OpenCode startup can be slow on first run (provider config, auth checks, etc.).
   * Prefer a conservative init timeout to avoid false failures.
   */
  init: 60_000,
  toolCall: 120_000,
  investigation: 300_000,
  think: 30_000,
  idle: 500,
} as const;

const OPENCODE_TOOL_PATTERNS: readonly ToolPatternWithInputFields[] = [
  {
    name: 'change_title',
    patterns: ['change_title', 'change-title', 'happy__change_title', 'mcp__happy__change_title'],
    inputFields: ['title'],
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
  // OpenCode CLI tool conventions
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
] as const;

export class OpenCodeTransport implements TransportHandler {
  readonly agentName = 'opencode';

  getInitTimeout(): number {
    return OPENCODE_TIMEOUTS.init;
  }

  filterStdoutLine(line: string): string | null {
    return filterJsonObjectOrArrayLine(line);
  }

  handleStderr(text: string, context: StderrContext): StderrResult {
    const trimmed = text.trim();
    if (!trimmed) return { message: null, suppress: true };

    // Rate limit errors - OpenCode (or its providers) may retry; keep logs for debugging.
    if (
      trimmed.includes('429') ||
      trimmed.toLowerCase().includes('rate limit') ||
      trimmed.includes('RATE_LIMIT')
    ) {
      return { message: null, suppress: false };
    }

    // Authentication error - show actionable message.
    if (
      trimmed.toLowerCase().includes('authentication') ||
      trimmed.toLowerCase().includes('unauthorized') ||
      trimmed.toLowerCase().includes('api key')
    ) {
      const errorMessage: AgentMessage = {
        type: 'status',
        status: 'error',
        detail: 'Authentication error. Run `opencode auth login` to configure API keys.',
      };
      return { message: errorMessage };
    }

    // Model not found - show actionable message.
    if (trimmed.toLowerCase().includes('model not found')) {
      const errorMessage: AgentMessage = {
        type: 'status',
        status: 'error',
        detail: 'Model not found. Check available models with `opencode models`.',
      };
      return { message: errorMessage };
    }

    // During long-running tools, keep stderr available for debugging but avoid noisy UI messages.
    if (context.hasActiveInvestigation) {
      const hasError =
        trimmed.includes('timeout') ||
        trimmed.includes('Timeout') ||
        trimmed.includes('failed') ||
        trimmed.includes('Failed') ||
        trimmed.includes('error') ||
        trimmed.includes('Error');

      if (hasError) return { message: null, suppress: false };
    }

    return { message: null };
  }

  getToolPatterns(): ToolPattern[] {
    // TransportHandler expects a mutable array type; keep our source list readonly and
    // return a shallow copy to satisfy the signature without risking accidental mutation.
    return [...OPENCODE_TOOL_PATTERNS];
  }

  determineToolName(
    toolName: string,
    toolCallId: string,
    input: Record<string, unknown>,
    _context: ToolNameContext
  ): string {
    if (toolName !== 'other' && toolName !== 'Unknown tool') return toolName;

    // 1) Prefer toolCallId pattern matching (most reliable).
    const idToolName = findToolNameFromId(toolCallId, OPENCODE_TOOL_PATTERNS, { preferLongestMatch: true });
    if (idToolName) return idToolName;

    // 2) Fallback to input field signatures.
    const inputToolName = findToolNameFromInputFields(input, OPENCODE_TOOL_PATTERNS);
    if (inputToolName) return inputToolName;

    if (toolName === 'other' || toolName === 'Unknown tool') {
      const inputKeys = input && typeof input === 'object' ? Object.keys(input) : [];
      logger.debug(
        `[OpenCodeTransport] Unknown tool pattern - toolCallId: "${toolCallId}", ` +
          `toolName: "${toolName}", inputKeys: [${inputKeys.join(', ')}].`
      );
    }

    return toolName;
  }

  extractToolNameFromId(toolCallId: string): string | null {
    return findToolNameFromId(toolCallId, OPENCODE_TOOL_PATTERNS, { preferLongestMatch: true });
  }

  isInvestigationTool(toolCallId: string, toolKind?: string): boolean {
    const lowerId = toolCallId.toLowerCase();
    return (
      lowerId.includes('task') ||
      lowerId.includes('explore') ||
      (typeof toolKind === 'string' && toolKind.includes('task'))
    );
  }

  getToolCallTimeout(toolCallId: string, toolKind?: string): number {
    if (this.isInvestigationTool(toolCallId, toolKind)) return OPENCODE_TIMEOUTS.investigation;
    if (toolKind === 'think') return OPENCODE_TIMEOUTS.think;
    return OPENCODE_TIMEOUTS.toolCall;
  }

  getIdleTimeout(): number {
    return OPENCODE_TIMEOUTS.idle;
  }
}

export const openCodeTransport = new OpenCodeTransport();
