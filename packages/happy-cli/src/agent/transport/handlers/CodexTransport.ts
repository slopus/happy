/**
 * CodexTransport - Transport handler for Codex CLI
 *
 * Implements TransportHandler for Codex-specific behaviors.
 * Used by CodexAppServerBackend for stdout filtering, stderr handling,
 * and tool name pattern matching.
 */

import type { TransportHandler, ToolPattern, StderrContext, StderrResult, ToolNameContext } from '../TransportHandler';

export class CodexTransport implements TransportHandler {
  readonly agentName = 'codex';

  getInitTimeout(): number {
    return 30_000; // 30 seconds for Codex startup
  }

  filterStdoutLine(line: string): string | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    // Only pass through valid JSON objects
    if (trimmed.startsWith('{')) return trimmed;

    // Drop non-JSON lines (npm output, debug messages, etc.)
    return null;
  }

  handleStderr(text: string, _context: StderrContext): StderrResult {
    const lower = text.toLowerCase();

    // API key errors
    if (lower.includes('api key') || lower.includes('unauthorized') || lower.includes('authentication')) {
      return {
        message: { type: 'status', status: 'error', detail: `Auth error: ${text.trim()}` },
      };
    }

    // Rate limiting
    if (lower.includes('rate limit') || lower.includes('429')) {
      return {
        message: { type: 'status', status: 'error', detail: `Rate limited: ${text.trim()}` },
      };
    }

    // Suppress common non-error stderr noise
    if (lower.includes('npm warn') || lower.includes('experimentalwarning') || lower.includes('deprecation')) {
      return { message: null, suppress: true };
    }

    return { message: null };
  }

  createTool(name: string, patterns?: string[]): ToolPattern {
    return {
      name,
      patterns: patterns ?? [name],
    };
  }

  getToolPatterns(): ToolPattern[] {
    const orchestratorTools = [
    'orchestrator_get_context',
    'orchestrator_submit',
    'orchestrator_pend',
    'orchestrator_list',
    'orchestrator_cancel',
    'orchestrator_send_message',
  ];

  return [
    this.createTool('change_title'),
    this.createTool('preview_html'),

    ...orchestratorTools.map(name => this.createTool(name)),

    this.createTool('bash', ['bash', 'shell', 'terminal', 'exec']),
    this.createTool('edit', ['edit', 'write', 'patch', 'apply_patch']),
  ];
  }

  getIdleTimeout(): number {
    return 500;
  }

  isInvestigationTool(_toolCallId: string, _toolKind?: string): boolean {
    return false;
  }

  getToolCallTimeout(_toolCallId: string, _toolKind?: string): number {
    return 120_000; // 2 minutes default
  }

  extractToolNameFromId(toolCallId: string): string | null {
    const patterns = this.getToolPatterns();
    const lower = toolCallId.toLowerCase();
    for (const pattern of patterns) {
      for (const p of pattern.patterns) {
        if (lower.includes(p.toLowerCase())) {
          return pattern.name;
        }
      }
    }
    return null;
  }

  determineToolName(
    toolName: string,
    toolCallId: string,
    _input: Record<string, unknown>,
    _context: ToolNameContext
  ): string {
    if (toolName && toolName !== 'other' && toolName !== 'Unknown tool') {
      return toolName;
    }

    return this.extractToolNameFromId(toolCallId) ?? toolName;
  }
}

export const codexTransport = new CodexTransport();
