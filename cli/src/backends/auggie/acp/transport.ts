/**
 * Auggie Transport Handler
 *
 * TransportHandler for Auggie's ACP mode (`auggie --acp`).
 */

import type {
  TransportHandler,
  ToolPattern,
  StderrContext,
  StderrResult,
  ToolNameContext,
} from '@/agent/transport/TransportHandler';
import type { AgentMessage } from '@/agent/core';
import { filterJsonObjectOrArrayLine } from '@/agent/transport/utils/jsonStdoutFilter';
import {
  findToolNameFromId,
  findToolNameFromInputFields,
  type ToolPatternWithInputFields,
} from '@/agent/transport/utils/toolPatternInference';

export const AUGGIE_TIMEOUTS = {
  init: 60_000,
  toolCall: 120_000,
  investigation: 600_000,
  think: 30_000,
  idle: 500,
} as const;

const AUGGIE_TOOL_PATTERNS: readonly ToolPatternWithInputFields[] = [
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
] as const;

export class AuggieTransport implements TransportHandler {
  readonly agentName = 'auggie';

  getInitTimeout(): number {
    return AUGGIE_TIMEOUTS.init;
  }

  filterStdoutLine(line: string): string | null {
    return filterJsonObjectOrArrayLine(line);
  }

  handleStderr(text: string, _context: StderrContext): StderrResult {
    const trimmed = text.trim();
    if (!trimmed) return { message: null, suppress: true };

    // Avoid being clever; we mainly need stdout hygiene for ACP.
    // Emit actionable auth hints when possible.
    const lower = trimmed.toLowerCase();
    if (lower.includes('unauthorized') || lower.includes('authentication') || lower.includes('api key') || lower.includes('token')) {
      const errorMessage: AgentMessage = {
        type: 'status',
        status: 'error',
        detail: 'Authentication error. Run `auggie login` or set AUGMENT_SESSION_AUTH in your environment.',
      };
      return { message: errorMessage };
    }

    return { message: null, suppress: false };
  }

  getToolPatterns(): ToolPattern[] {
    return [...AUGGIE_TOOL_PATTERNS];
  }

  extractToolNameFromId(toolCallId: string): string | null {
    return findToolNameFromId(toolCallId, AUGGIE_TOOL_PATTERNS, { preferLongestMatch: true });
  }

  determineToolName(
    toolName: string,
    toolCallId: string,
    input: Record<string, unknown>,
    _context: ToolNameContext,
  ): string {
    const idToolName = findToolNameFromId(toolCallId, AUGGIE_TOOL_PATTERNS, { preferLongestMatch: true });
    if (idToolName) return idToolName;

    if (toolName !== 'other' && toolName !== 'Unknown tool') return toolName;

    const inputToolName = findToolNameFromInputFields(input, AUGGIE_TOOL_PATTERNS);
    if (inputToolName) return inputToolName;

    return toolName;
  }

  getToolCallTimeout(toolCallId: string, toolKind?: string): number {
    const lowerId = toolCallId.toLowerCase();
    if (lowerId.includes('investigat') || lowerId.includes('index') || lowerId.includes('search')) {
      return AUGGIE_TIMEOUTS.investigation;
    }
    if (toolKind === 'think') return AUGGIE_TIMEOUTS.think;
    return AUGGIE_TIMEOUTS.toolCall;
  }

  getIdleTimeout(): number {
    return AUGGIE_TIMEOUTS.idle;
  }
}

export const auggieTransport = new AuggieTransport();

