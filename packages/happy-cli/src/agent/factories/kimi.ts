/**
 * Kimi ACP Backend - Kimi CLI agent via ACP
 *
 * This module provides a factory function for creating a Kimi backend
 * that communicates using the Agent Client Protocol (ACP).
 *
 * Kimi CLI supports ACP mode via the `kimi acp` command.
 */

import { AcpBackend, type AcpBackendOptions, type AcpPermissionHandler } from '../acp/AcpBackend';
import type { AgentBackend, McpServerConfig, AgentFactoryOptions } from '../core';
import { agentRegistry } from '../core';
import { kimiTransport } from '../transport';
import { logger } from '@/ui/logger';
import { KIMI_API_KEY_ENV, DEFAULT_KIMI_MODEL } from '@/kimi/constants';

/**
 * Options for creating a Kimi ACP backend
 */
export interface KimiBackendOptions extends AgentFactoryOptions {
  /** API key for Kimi (optional, usually via `kimi login`) */
  apiKey?: string;

  /** Model to use. If undefined, will use default. */
  model?: string | null;

  /** MCP servers to make available to the agent */
  mcpServers?: Record<string, McpServerConfig>;

  /** Optional permission handler for tool approval */
  permissionHandler?: AcpPermissionHandler;
}

/**
 * Result of creating a Kimi backend
 */
export interface KimiBackendResult {
  /** The created AgentBackend instance */
  backend: AgentBackend;
  /** The resolved model that will be used */
  model: string;
  /** Source of the model selection for logging */
  modelSource: 'explicit' | 'env-var' | 'default';
}

/**
 * Create a Kimi backend using ACP.
 *
 * The Kimi CLI must be installed and available in PATH.
 * Uses the `kimi acp` command to enable ACP mode.
 *
 * @param options - Configuration options
 * @returns KimiBackendResult with backend and resolved model
 */
export function createKimiBackend(options: KimiBackendOptions): KimiBackendResult {
  // Resolve API key from environment or options
  // Note: Kimi CLI usually handles auth via `kimi login`, so API key is optional
  const apiKey = process.env[KIMI_API_KEY_ENV] || options.apiKey;

  // Resolve model
  const model = options.model || DEFAULT_KIMI_MODEL;

  // Command to run kimi
  const kimiCommand = 'kimi';

  // Build args - use 'acp' subcommand for ACP mode
  const kimiArgs = ['acp'];

  const backendOptions: AcpBackendOptions = {
    agentName: 'kimi',
    cwd: options.cwd,
    command: kimiCommand,
    args: kimiArgs,
    env: {
      ...options.env,
      ...(apiKey ? { [KIMI_API_KEY_ENV]: apiKey } : {}),
      // Suppress debug output
      NODE_ENV: 'production',
      DEBUG: '',
    },
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
    transportHandler: kimiTransport,
    // Check if prompt instructs the agent to change title
    hasChangeTitleInstruction: (prompt: string) => {
      const lower = prompt.toLowerCase();
      return lower.includes('change_title') ||
             lower.includes('change title') ||
             lower.includes('set title') ||
             lower.includes('mcp__happy__change_title');
    },
  };

  // Determine model source for logging
  const modelSource = options.model ? 'explicit' : 'default';

  logger.debug('[Kimi] Creating ACP backend with options:', {
    cwd: backendOptions.cwd,
    command: backendOptions.command,
    args: backendOptions.args,
    hasApiKey: !!apiKey,
    model: model,
    modelSource: modelSource,
    mcpServerCount: options.mcpServers ? Object.keys(options.mcpServers).length : 0,
  });

  return {
    backend: new AcpBackend(backendOptions),
    model,
    modelSource,
  };
}

/**
 * Register Kimi backend with the global agent registry.
 *
 * This function should be called during application initialization
 * to make the Kimi agent available for use.
 */
export function registerKimiAgent(): void {
  agentRegistry.register('kimi', (opts) => createKimiBackend(opts).backend);
  logger.debug('[Kimi] Registered with agent registry');
}
