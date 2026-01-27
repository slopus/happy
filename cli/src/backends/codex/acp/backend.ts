/**
 * Codex ACP Backend Factory
 *
 * Creates an ACP backend for Codex via the optional `codex-acp` capability install.
 * Mirrors the Gemini ACP factory pattern (single place for command resolution).
 */

import { AcpBackend, type AcpBackendOptions, type AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { AgentBackend, AgentFactoryOptions, McpServerConfig } from '@/agent/core';
import { resolveCodexAcpCommand } from '@/backends/codex/acp/resolveCommand';

export interface CodexAcpBackendOptions extends AgentFactoryOptions {
  mcpServers?: Record<string, McpServerConfig>;
  permissionHandler?: AcpPermissionHandler;
}

export interface CodexAcpBackendResult {
  backend: AgentBackend;
  command: string;
}

export function createCodexAcpBackend(options: CodexAcpBackendOptions): CodexAcpBackendResult {
  const command = resolveCodexAcpCommand();

  const backendOptions: AcpBackendOptions = {
    agentName: 'codex',
    cwd: options.cwd,
    command,
    args: [],
    env: options.env,
    mcpServers: options.mcpServers,
    permissionHandler: options.permissionHandler,
  };

  return { backend: new AcpBackend(backendOptions), command };
}
