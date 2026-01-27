/**
 * Auggie ACP Backend - Auggie CLI agent via ACP.
 *
 * Auggie must be installed and available in PATH.
 * ACP mode: `auggie --acp`
 *
 * Indexing:
 * - When enabled, we pass `--allow-indexing` (Auggie 0.7.0+).
 */

import { AcpBackend, type AcpBackendOptions, type AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { AgentBackend, AgentFactoryOptions, McpServerConfig } from '@/agent/core';
import { auggieTransport } from '@/backends/auggie/acp/transport';

export interface AuggieBackendOptions extends AgentFactoryOptions {
  mcpServers?: Record<string, McpServerConfig>;
  permissionHandler?: AcpPermissionHandler;
  allowIndexing?: boolean;
}

export function createAuggieBackend(options: AuggieBackendOptions): AgentBackend {
  const allowIndexing = options.allowIndexing === true;

  const args = ['--acp', ...(allowIndexing ? ['--allow-indexing'] : [])];

  const backendOptions: AcpBackendOptions = {
    agentName: 'auggie',
    cwd: options.cwd,
    command: 'auggie',
    args,
    env: {
      ...options.env,
      // Keep output clean; ACP must own stdout.
      NODE_ENV: 'production',
      DEBUG: '',
    },
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
    transportHandler: auggieTransport,
  };

  return new AcpBackend(backendOptions);
}

