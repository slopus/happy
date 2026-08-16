/**
 * Hermes ACP Backend - Hermes CLI agent via ACP
 *
 * This module provides a factory function for creating a Hermes backend
 * that communicates using the Agent Client Protocol (ACP).
 *
 * Hermes manages its own authentication (via its native login command), so
 * this factory inherits the user's shell environment per the generic ACP
 * runner principles — no credentials or API keys are resolved here.
 */

import { AcpBackend, type AcpBackendOptions, type AcpPermissionHandler } from '../acp/AcpBackend';
import type { AgentBackend, McpServerConfig, AgentFactoryOptions } from '../core';
import { agentRegistry } from '../core';
import { hermesTransport } from '../transport';
import { logger } from '@/ui/logger';

/**
 * Options for creating a Hermes ACP backend
 */
export interface HermesBackendOptions extends AgentFactoryOptions {
  /** MCP servers to make available to the agent */
  mcpServers?: Record<string, McpServerConfig>;

  /** Optional permission handler for tool approval */
  permissionHandler?: AcpPermissionHandler;
}

/**
 * Create a Hermes backend using ACP (official SDK).
 *
 * The Hermes CLI must be installed and available in PATH.
 * Authentication is handled by the Hermes CLI itself (native login);
 * no API keys are injected here.
 *
 * @param options - Configuration options
 * @returns The created AgentBackend instance
 */
export function createHermesBackend(options: HermesBackendOptions): AgentBackend {
  const backendOptions: AcpBackendOptions = {
    agentName: 'hermes',
    cwd: options.cwd,
    command: 'hermes',
    args: ['acp'],
    env: options.env,
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
    transportHandler: hermesTransport,
    // Check if prompt instructs the agent to change title (for auto-approval of change_title tool)
    hasChangeTitleInstruction: (prompt: string) => {
      const lower = prompt.toLowerCase();
      return lower.includes('change_title') ||
             lower.includes('change title') ||
             lower.includes('set title') ||
             lower.includes('mcp__happy__change_title');
    },
  };

  logger.debug('[Hermes] Creating ACP SDK backend with options:', {
    cwd: backendOptions.cwd,
    command: backendOptions.command,
    args: backendOptions.args,
    mcpServerCount: options.mcpServers ? Object.keys(options.mcpServers).length : 0,
  });

  return new AcpBackend(backendOptions);
}

/**
 * Register Hermes backend with the global agent registry.
 *
 * This function should be called during application initialization
 * to make the Hermes agent available for use.
 */
export function registerHermesAgent(): void {
  agentRegistry.register('hermes', (opts) => createHermesBackend(opts));
  logger.debug('[Hermes] Registered with agent registry');
}
