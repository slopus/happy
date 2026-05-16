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
import { DefaultTransport } from '../transport';
import { logger } from '@/ui/logger';

/**
 * Options for creating a Kimi ACP backend
 */
export interface KimiBackendOptions extends AgentFactoryOptions {
  /** API key for Kimi (defaults to KIMI_API_KEY env var) */
  apiKey?: string;

  /** Model to use. If undefined, Kimi CLI will use its config default. */
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
  model: string | null;
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
  const apiKey = options.apiKey || process.env.KIMI_API_KEY || undefined;
  const model = options.model ?? null;

  const backendOptions: AcpBackendOptions = {
    agentName: 'kimi',
    cwd: options.cwd,
    command: 'kimi',
    args: ['acp'],
    env: {
      ...options.env,
      ...(apiKey ? { KIMI_API_KEY: apiKey } : {}),
      ...(model ? { KIMI_MODEL: model } : {}),
    },
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
    transportHandler: new DefaultTransport('kimi'),
  };

  logger.debug('[Kimi] Creating ACP backend with options:', {
    cwd: backendOptions.cwd,
    command: backendOptions.command,
    args: backendOptions.args,
    hasApiKey: !!apiKey,
    model: model,
    mcpServerCount: options.mcpServers ? Object.keys(options.mcpServers).length : 0,
  });

  return {
    backend: new AcpBackend(backendOptions),
    model,
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
