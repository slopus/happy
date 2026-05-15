/**
 * Kimi ACP Backend - Kimi Code CLI agent via ACP
 *
 * This module provides a factory function for creating a Kimi backend
 * that communicates using the Agent Client Protocol (ACP).
 *
 * Kimi Code CLI supports ACP mode via the `kimi acp` subcommand.
 */

import { AcpBackend, type AcpBackendOptions, type AcpPermissionHandler } from '../acp/AcpBackend';
import type { AgentBackend, McpServerConfig, AgentFactoryOptions } from '../core';
import { agentRegistry } from '../core';
import { kimiTransport } from '../transport';
import { logger } from '@/ui/logger';

/** Environment variable name for Kimi API key */
export const KIMI_API_KEY_ENV = 'KIMI_API_KEY';

/**
 * Options for creating a Kimi ACP backend
 */
export interface KimiBackendOptions extends AgentFactoryOptions {
  /** API key for Kimi (defaults to KIMI_API_KEY env var) */
  apiKey?: string;

  /** MCP servers to make available to the agent */
  mcpServers?: Record<string, McpServerConfig>;

  /** Optional permission handler for tool approval */
  permissionHandler?: AcpPermissionHandler;
}

/**
 * Create a Kimi backend using ACP.
 *
 * The Kimi CLI must be installed and available in PATH.
 * Uses the `acp` subcommand to enable ACP mode.
 *
 * @param options - Configuration options
 * @returns The created AgentBackend instance
 */
export function createKimiBackend(options: KimiBackendOptions): AgentBackend {
  // Resolve API key
  const apiKey = options.apiKey || process.env[KIMI_API_KEY_ENV];

  if (!apiKey) {
    logger.warn(
      `[Kimi] No API key found. Set ${KIMI_API_KEY_ENV} environment variable or run 'kimi auth'.`
    );
  }

  const backendOptions: AcpBackendOptions = {
    agentName: 'kimi',
    cwd: options.cwd,
    command: 'kimi',
    args: ['acp'],
    env: {
      ...options.env,
      ...(apiKey ? { [KIMI_API_KEY_ENV]: apiKey } : {}),
    },
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
    transportHandler: kimiTransport,
    hasChangeTitleInstruction: (prompt: string) => {
      const lower = prompt.toLowerCase();
      return (
        lower.includes('change_title') ||
        lower.includes('change title') ||
        lower.includes('set title') ||
        lower.includes('mcp__happy__change_title')
      );
    },
  };

  logger.debug('[Kimi] Creating ACP backend with options:', {
    cwd: backendOptions.cwd,
    command: backendOptions.command,
    args: backendOptions.args,
    hasApiKey: !!apiKey,
    mcpServerCount: options.mcpServers ? Object.keys(options.mcpServers).length : 0,
  });

  return new AcpBackend(backendOptions);
}

/**
 * Register Kimi backend with the global agent registry.
 *
 * This function should be called during application initialization
 * to make the Kimi agent available for use.
 */
export function registerKimiAgent(): void {
  agentRegistry.register('kimi', (opts) => createKimiBackend(opts));
  logger.debug('[Kimi] Registered with agent registry');
}
