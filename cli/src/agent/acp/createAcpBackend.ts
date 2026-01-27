/**
 * ACP Backend Factory Helper
 *
 * Provides a simplified factory function for creating ACP-based agent backends.
 * Use this when you need to create a generic ACP backend without agent-specific
 * configuration (timeouts, filtering, etc.).
 *
 * For agent-specific backends, use the agent ACP backends in:
 * - createGeminiBackend() - Gemini CLI with GeminiTransport
 * - createCodexBackend() - Codex CLI with CodexTransport
 * - createClaudeBackend() - Claude CLI with ClaudeTransport
 *
 * @module createAcpBackend
 */

import { AcpBackend, type AcpBackendOptions, type AcpPermissionHandler } from './AcpBackend';
import type { AgentBackend, McpServerConfig } from '../core';
import { DefaultTransport, type TransportHandler } from '../transport';

/**
 * Simplified options for creating an ACP backend
 */
export interface CreateAcpBackendOptions {
  /** Agent name for identification */
  agentName: string;

  /** Working directory for the agent */
  cwd: string;

  /** Command to spawn the ACP agent */
  command: string;

  /** Arguments for the agent command */
  args?: string[];

  /** Environment variables to pass to the agent */
  env?: Record<string, string>;

  /** MCP servers to make available to the agent */
  mcpServers?: Record<string, McpServerConfig>;

  /** Optional permission handler for tool approval */
  permissionHandler?: AcpPermissionHandler;

  /** Optional transport handler for agent-specific behavior */
  transportHandler?: TransportHandler;
}

/**
 * Create a generic ACP backend.
 *
 * This is a low-level factory for creating ACP backends. For most use cases,
 * prefer the agent-specific factories that include proper transport handlers:
 *
 * ```typescript
 * // Prefer this:
 * import { createGeminiBackend } from '@/backends/gemini/acp/backend';
 * const backend = createGeminiBackend({ cwd: '/path/to/project' });
 *
 * // Over this:
 * import { createAcpBackend } from '@/agent/acp';
 * const backend = createAcpBackend({
 *   agentName: 'gemini',
 *   cwd: '/path/to/project',
 *   command: 'gemini',
 *   args: ['--experimental-acp'],
 * });
 * ```
 *
 * @param options - Configuration options
 * @returns AgentBackend instance
 */
export function createAcpBackend(options: CreateAcpBackendOptions): AgentBackend {
  const backendOptions: AcpBackendOptions = {
    agentName: options.agentName,
    cwd: options.cwd,
    command: options.command,
    args: options.args,
    env: options.env,
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
    transportHandler: options.transportHandler ?? new DefaultTransport(options.agentName),
  };

  return new AcpBackend(backendOptions);
}
