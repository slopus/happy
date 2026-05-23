/**
 * Hermes ACP Backend - Hermes Agent CLI via ACP
 *
 * This module provides a factory function for creating a Hermes backend
 * that communicates using the Agent Client Protocol (ACP).
 *
 * Hermes Agent (NousResearch/hermes-agent) ships ACP support via the
 * `hermes acp` command, installed with `pip install 'hermes-agent[acp]'`.
 */

import { AcpBackend, type AcpBackendOptions, type AcpPermissionHandler } from '../acp/AcpBackend';
import type { AgentBackend, McpServerConfig, AgentFactoryOptions } from '../core';
import { agentRegistry } from '../core';
import { DefaultTransport } from '../transport';
import { logger } from '@/ui/logger';

/**
 * Options for creating a Hermes ACP backend
 */
export interface HermesBackendOptions extends AgentFactoryOptions {
  /** API key passthrough for upstream Hermes providers (set via env if provided) */
  apiKey?: string;

  /** Model to use. If undefined, Hermes CLI will use its config default. */
  model?: string | null;

  /** MCP servers to make available to the agent */
  mcpServers?: Record<string, McpServerConfig>;

  /** Optional permission handler for tool approval */
  permissionHandler?: AcpPermissionHandler;
}

/**
 * Result of creating a Hermes backend
 */
export interface HermesBackendResult {
  /** The created AgentBackend instance */
  backend: AgentBackend;
  /** The resolved model that will be used */
  model: string | null;
}

/**
 * Create a Hermes backend using ACP.
 *
 * The Hermes Agent CLI must be installed with the `acp` extra and available
 * on PATH. Uses the `hermes acp` command to enable ACP mode.
 *
 * @param options - Configuration options
 * @returns HermesBackendResult with backend and resolved model
 */
export function createHermesBackend(options: HermesBackendOptions): HermesBackendResult {
  const apiKey = options.apiKey || undefined;
  const model = options.model ?? null;

  const backendOptions: AcpBackendOptions = {
    agentName: 'hermes',
    cwd: options.cwd,
    command: 'hermes',
    args: ['acp'],
    env: {
      ...options.env,
      ...(apiKey ? { HERMES_API_KEY: apiKey } : {}),
      ...(model ? { HERMES_MODEL: model } : {}),
    },
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
    transportHandler: new DefaultTransport('hermes'),
  };

  logger.debug('[Hermes] Creating ACP backend with options:', {
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
 * Register Hermes backend with the global agent registry.
 *
 * This function should be called during application initialization
 * to make the Hermes agent available for use.
 */
export function registerHermesAgent(): void {
  agentRegistry.register('hermes', (opts) => createHermesBackend(opts).backend);
  logger.debug('[Hermes] Registered with agent registry');
}
