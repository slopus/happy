/**
 * OpenCode ACP Backend - OpenCode agent via ACP
 *
 * This module provides a factory function for creating an OpenCode backend
 * that communicates using the Agent Client Protocol (ACP).
 *
 * OpenCode must be installed and available in PATH.
 * ACP mode: `opencode acp`
 */

import { AcpBackend, type AcpBackendOptions, type AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { AgentBackend, McpServerConfig, AgentFactoryOptions } from '@/agent/core';
import { openCodeTransport } from '@/backends/opencode/acp/transport';
import { logger } from '@/ui/logger';

export interface OpenCodeBackendOptions extends AgentFactoryOptions {
  /** MCP servers to make available to the agent */
  mcpServers?: Record<string, McpServerConfig>;
  /** Optional permission handler for tool approval */
  permissionHandler?: AcpPermissionHandler;
}

export function createOpenCodeBackend(options: OpenCodeBackendOptions): AgentBackend {
  const backendOptions: AcpBackendOptions = {
    agentName: 'opencode',
    cwd: options.cwd,
    command: 'opencode',
    args: ['acp'],
    env: {
      ...options.env,
      // Keep output clean; ACP must own stdout.
      NODE_ENV: 'production',
      DEBUG: '',
    },
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
    transportHandler: openCodeTransport,
  };

  logger.debug('[OpenCode] Creating ACP backend with options:', {
    cwd: backendOptions.cwd,
    command: backendOptions.command,
    args: backendOptions.args,
    mcpServerCount: options.mcpServers ? Object.keys(options.mcpServers).length : 0,
  });

  return new AcpBackend(backendOptions);
}
