/**
 * Crush Agent Backend
 *
 * Factory for creating Crush backends that communicate with the Crush
 * server (`crush server`) over HTTP and SSE, using a per-session Unix
 * domain socket.
 *
 * @module crush
 */

import { CrushServerBackend } from './CrushServerBackend';
import type { AgentBackend, McpServerConfig, AgentFactoryOptions } from '../core';
import { agentRegistry } from '../core';

export { CrushServerBackend, mapCrushEventToAgentMessages } from './CrushServerBackend';
export type { CrushServerBackendOptions, CrushEvent } from './CrushServerBackend';

/**
 * Options for creating a Crush backend
 */
export interface CrushBackendOptions extends AgentFactoryOptions {
  /** MCP servers to make available to the agent */
  mcpServers?: Record<string, McpServerConfig>;

  /** Custom crush binary path (defaults to 'crush') */
  command?: string;

  /** Extra arguments to pass to `crush server` */
  extraArgs?: string[];
}

/**
 * Create a Crush backend using the Crush server HTTP API.
 *
 * The Crush CLI must be installed and available in PATH.
 * Authentication is handled by the Crush CLI itself (native login);
 * no API keys are resolved or injected here.
 *
 * @param options - Configuration options
 * @returns The created AgentBackend instance
 */
export function createCrushBackend(options: CrushBackendOptions): AgentBackend {
  return new CrushServerBackend({
    agentName: 'crush',
    cwd: options.cwd,
    env: options.env,
    mcpServers: options.mcpServers,
    command: options.command,
    extraArgs: options.extraArgs,
  });
}

/**
 * Register Crush backend with the global agent registry.
 *
 * This function should be called during application initialization
 * to make the Crush agent available for use.
 */
export function registerCrushAgent(): void {
  agentRegistry.register('crush', (opts) => createCrushBackend(opts));
}
